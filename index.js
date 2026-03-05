const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const app = express();

// Initialize Supabase using Environment Variables in Render
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(express.text()); // ADMS sends data in plain text/tab-separated format

// 1. HOME ROUTE (Status Page)
app.get("/", (req, res) => {
  res.send("<h1>🚀 Gym Bridge is Online and Ready!</h1>");
});

// 2. HANDSHAKE & COMMAND SYNC
app.get("/iclock/getrequest", async (req, res) => {
  const sn = req.query.SN;
  console.log(`Device ${sn} checking for commands...`);

  // FIXED: Changed table name to 'members'
  const { data: newMember, error } = await supabase
    .from("members")
    .select("*")
    .eq("is_synced", false)
    .limit(1)
    .single();

  if (newMember && !error) {
    console.log(`📡 Syncing Card ${newMember.card_number} for ${newMember.full_name}`);

    // The command the F22 understands to add a user and card
    const command = `C:101:SET USER ID=${newMember.machine_id}\tName=${newMember.full_name}\tCard=${newMember.card_number}\tGroup=1`;

    // FIXED: Changed table name to 'members'
    await supabase
      .from("members")
      .update({ is_synced: true })
      .eq("id", newMember.id);

    return res.send(command);
  }

  res.send("OK");
});

// 3. DATA PUSH (Attendance & Enrollment)
app.post("/iclock/cdata", async (req, res) => {
  const table = req.query.table;

  if (table === "ATTLOG") {
    const lines = req.body.trim().split("\n");
    for (let line of lines) {
      const [userId, timestamp] = line.split("\t");
      console.log(`Verification received for User ID: ${userId}`);

      // FIXED: Changed table name to 'members'
      const { data: member } = await supabase
        .from("members")
        .select("*")
        .eq("machine_id", userId)
        .single();

      const now = new Date();
      // FIXED: Changed column name from 'expiry_date' to 'expiry'
      const expiry = member ? new Date(member.expiry) : null;

      if (member && member.is_active && expiry > now) {
        console.log(`🔓 Access Granted for ${member.full_name}`);

        await supabase.from("attendance_history").insert([
          { member_id: member.id, machine_id: userId, status: "Success" },
        ]);

        // Trigger the physical relay on the F22
        return res.send("OK\nSET OPTION UNLOCK=5");
      } else {
        console.log(`🔒 Access Denied for User ID: ${userId}`);
        return res.send("OK");
      }
    }
  }
  res.send("OK");
});

// 4. SERVER START
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Bridge Server live on port ${PORT}`));