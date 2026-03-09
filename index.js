const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PORT = process.env.PORT || 10000;
const UNLOCK_COMMAND = process.env.F22_UNLOCK_COMMAND || "SET OPTION UNLOCK=5";

// In-memory queue by device serial number (SN) for ADMS command polling.
const pendingCommandsBySn = new Map();

// F22/ADMS can send plain text with inconsistent content-types.
app.use(express.text({ type: "*/*", limit: "2mb" }));

function textOk(res, body = "OK") {
  res.set("Content-Type", "text/plain; charset=utf-8");
  return res.status(200).send(body);
}

function normalizeBody(rawBody) {
  if (typeof rawBody !== "string") return "";
  return rawBody.replace(/\r/g, "").trim();
}

function parseAttlogLines(rawBody) {
  const body = normalizeBody(rawBody);
  if (!body) return [];

  const rows = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const events = [];

  for (const line of rows) {
    // Common ADMS forms:
    // 1) "101\t2026-03-06 09:01:02"
    // 2) "ATTLOG\tPIN=101\tDateTime=2026-03-06 09:01:02\t..."
    const parts = line.split("\t");

    if (parts[0] === "ATTLOG") {
      const kv = {};
      for (const token of parts.slice(1)) {
        const idx = token.indexOf("=");
        if (idx > 0) {
          const key = token.slice(0, idx).trim();
          const value = token.slice(idx + 1).trim();
          kv[key] = value;
        }
      }

      const pin = kv.PIN || kv.UserID || kv.PIN2 || "";
      const dateTime = kv.DateTime || kv.TIME || null;
      if (pin) {
        events.push({ machineId: Number(pin), scannedAt: dateTime, raw: line });
      }
      continue;
    }

    const simpleId = Number(parts[0]);
    const simpleTime = parts[1] || null;
    if (!Number.isNaN(simpleId) && simpleId > 0) {
      events.push({ machineId: simpleId, scannedAt: simpleTime, raw: line });
    }
  }

  return events;
}

function queueCommand(sn, commandPayload) {
  const command = `C:${Date.now()}:${commandPayload}`;
  const key = sn || "UNKNOWN_SN";
  if (!pendingCommandsBySn.has(key)) {
    pendingCommandsBySn.set(key, []);
  }
  pendingCommandsBySn.get(key).push(command);
  console.log(`[QUEUE] SN=${key} command=${command}`);
}

function dequeueCommand(sn) {
  const key = sn || "UNKNOWN_SN";
  const queue = pendingCommandsBySn.get(key);
  if (!queue || queue.length === 0) return null;
  const cmd = queue.shift();
  if (queue.length === 0) {
    pendingCommandsBySn.delete(key);
  }
  return cmd;
}

app.get("/", (req, res) => {
  return textOk(res, "Gym Bridge is Online");
});

app.get("/healthz", (req, res) => {
  return textOk(res, "OK");
});

// Device heartbeat/command poll.
app.get("/iclock/getrequest", async (req, res) => {
  const sn = req.query.SN || "UNKNOWN_SN";
  console.log(`[GETREQUEST] SN=${sn} query=${JSON.stringify(req.query)}`);

  // Priority 1: deliver queued runtime commands (e.g., unlock).
  const queued = dequeueCommand(sn);
  if (queued) {
    return textOk(res, queued);
  }

  // Priority 2: deliver user sync commands.
  const { data: newMember, error } = await supabase
    .from("members")
    .select("id, machine_id, full_name, card_number")
    .eq("is_synced", false)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[GETREQUEST] Supabase read error:", error.message);
    return textOk(res, "OK");
  }

  if (!newMember) {
    return textOk(res, "OK");
  }

  const commandId = Date.now();
  const safeName = (newMember.full_name || "").replace(/[\t\n\r]/g, " ").trim();
  const safeCard = (newMember.card_number || "").replace(/[\t\n\r]/g, "").trim();

  // Command must be plain text for ADMS polling endpoint.
  const command = `C:${commandId}:SET USER ID=${newMember.machine_id}\tName=${safeName}\tCard=${safeCard}\tGroup=1`;

  const { error: updateError } = await supabase
    .from("members")
    .update({ is_synced: true })
    .eq("id", newMember.id);

  if (updateError) {
    console.error("[GETREQUEST] Failed to mark user synced:", updateError.message);
  } else {
    console.log(`[GETREQUEST] Queued user sync for machine_id=${newMember.machine_id}`);
  }

  return textOk(res, command);
});

// Attendance push endpoint from F22.
app.all("/iclock/cdata", async (req, res) => {
  const sn = req.query.SN || "UNKNOWN_SN";
  const table = req.query.table || "";
  const stamp = req.query.STAMP || "";

  console.log(
    `[CDATA] method=${req.method} SN=${sn} table=${table} stamp=${stamp} rawLen=${(req.body || "").length}`
  );

  // Some devices probe by GET first. ACK and wait for real POST data.
  if (req.method !== "POST") {
    return textOk(res, "OK");
  }

  if (table !== "ATTLOG") {
    return textOk(res, "OK");
  }

  const events = parseAttlogLines(req.body);
  if (!events.length) {
    console.log("[CDATA] ATTLOG received but no parseable records");
    return textOk(res, "OK");
  }

  for (const event of events) {
    const machineId = event.machineId;
    if (!machineId || Number.isNaN(machineId)) {
      continue;
    }

    const { data: member, error: memberError } = await supabase
      .from("members")
      .select("id, machine_id, full_name, expiry, is_active")
      .eq("machine_id", machineId)
      .maybeSingle();

    if (memberError) {
      console.error(`[CDATA] Member lookup error for machine_id=${machineId}:`, memberError.message);
      continue;
    }

    const now = new Date();
    const expiryDate = member?.expiry ? new Date(member.expiry) : null;
    const active = Boolean(member && member.is_active && expiryDate && expiryDate > now);

    if (member) {
      await supabase.from("attendance_history").insert([
        {
          member_id: member.id,
          machine_id: machineId,
          status: active ? "Success" : "Denied",
          scanned_at:
            !event.scannedAt || Number.isNaN(new Date(event.scannedAt).getTime())
              ? undefined
              : new Date(event.scannedAt).toISOString(),
        },
      ]);

      if (active) {
        // F22 unlock command is delivered on next /iclock/getrequest poll.
        queueCommand(sn, UNLOCK_COMMAND);
      }

      console.log(
        `[CDATA] machine_id=${machineId} member=${member.full_name || member.id} result=${active ? "GRANTED" : "DENIED"}`
      );
    } else {
      console.log(`[CDATA] Unknown machine_id=${machineId} (no member mapping)`);
    }
  }

  // Keep response strict plain text; no JSON, no HTML.
  return textOk(res, "OK");
});

app.listen(PORT, () => {
  console.log(`Gym Bridge listening on port ${PORT}`);
});
