const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const app = express();

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.text()); // ADMS sends data in plain text/tab-separated format

// 1. Handshake Endpoint (Device checks if server is alive)
app.get('/iclock/getrequest', (req, res) => {
    console.log(`Device Ping: SN=${req.query.SN}`);
    res.send("OK");
});

// 2. Data Endpoint (Where the fingerprint scans arrive)
app.post('/iclock/cdata', async (req, res) => {
    const sn = req.query.SN;
    const table = req.query.table;

    // We only care about attendance logs (ATTLOG)
    if (table === 'ATTLOG') {
        const lines = req.body.trim().split('\n');
        for (let line of lines) {
            const [userId, timestamp] = line.split('\t');
            console.log(`User ${userId} scanned at ${timestamp}`);

            // Check Supabase for active membership
            const { data: member } = await supabase
                .from('members')
                .select('*')
                .eq('machine_id', userId)
                .single();

            if (member && new Date(member.expiry) > new Date()) {
                console.log("🔓 Access Granted. Command Queued.");
                // ADMS Response to trigger the door
                return res.send("OK\nSET OPTION UNLOCK=5");
            }
        }
    }
    res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge Server on port ${PORT}`));