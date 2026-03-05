const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const app = express();

// Initialize Supabase using Environment Variables in Render
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

app.use(express.text()); // ADMS sends data in plain text/tab-separated format

// 1. HOME ROUTE (Status Page)
app.get("/", (req, res) => {
  res.send("<h1>🚀 Gym Bridge is Online and Ready!</h1>");
});

// 2. HANDSHAKE & COMMAND SYNC
// This is where the machine asks: "Is there anything new I need to do?"
app.get("/iclock/getrequest", async (req, res) => {
  const sn = req.query.SN; // Serial Number of the device
  console.log(`Device ${sn} checking for commands...`);

  // Check Supabase for any user that is not yet synced to the machine
  const { data: newMember, error } = await supabase
    .from("gym_members")
    .select("*")
    .eq("is_synced", false)
    .limit(1)
    .single();

  if (newMember && !error) {
    console.log(
      `📡 Syncing Card ${newMember.card_number} for ${newMember.full_name}`,
    );

    // ADMS Command: SET USER ID, Name, Card Number, and Access Group
    // Format: C:ID:DATA...
    const command = `C:101:SET USER ID=${newMember.machine_id}\tName=${newMember.full_name}\tCard=${newMember.card_number}\tGroup=1`;

    // After sending, mark as synced in Supabase so we don't send it again
    await supabase
      .from("gym_members")
      .update({ is_synced: true })
      .eq("id", newMember.id);

    return res.send(command);
  }

  res.send("OK"); // No new commands, keep heart beating
});

// 3. DATA PUSH (Attendance & Enrollment)
// This is where the machine says: "User X just scanned their card/finger"
app.post("/iclock/cdata", async (req, res) => {
  const table = req.query.table;

  if (table === "ATTLOG") {
    // Parse the raw tab-separated text from the device
    const lines = req.body.trim().split("\n");
    for (let line of lines) {
      const [userId, timestamp] = line.split("\t");
      console.log(`Verification received for User ID: ${userId}`);

      // Logic: Check Supabase for an active, unexpired membership
      const { data: member } = await supabase
        .from("gym_members")
        .select("*")
        .eq("machine_id", userId)
        .single();

      const now = new Date();
      const expiry = member ? new Date(member.expiry_date) : null;

      if (member && member.is_active && expiry > now) {
        console.log(`🔓 Access Granted for ${member.full_name}`);

        // Record attendance in history table (Optional but recommended)
        await supabase
          .from("attendance_history")
          .insert([
            { member_id: member.id, machine_id: userId, status: "Success" },
          ]);

        // SEND UNLOCK COMMAND: This makes the relay click open
        return res.send("OK\nSET OPTION UNLOCK=5");
      } else {
        console.log(`🔒 Access Denied for User ID: ${userId}`);
        return res.send("OK"); // No unlock command sent
      }
    }
  }
  res.send("OK");
});

// 4. SERVER START
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Bridge Server live on port ${PORT}`));
