const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8080; // Cloud Run uses port 8080 by default

// Dedicated folder for files
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer storage: keep files safely on disk
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safeName}`);
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(uploadDir));

// SQLite DB
const db = new sqlite3.Database('./database.sqlite');
db.run(`CREATE TABLE IF NOT EXISTS shares (
    share_id TEXT PRIMARY KEY,
    content TEXT,
    original_name TEXT,
    stored_name TEXT,
    created_at INTEGER
)`);

function generateId() {
    return Math.random().toString(36).substring(2, 6);
}

// 1. UPLOAD (Text or Any File Format)
app.post('/api/share', upload.single('file'), (req, res) => {
    const content = req.body.content || null;
    const file = req.file || null;

    if (!content && !file) return res.status(400).json({ error: "Nothing to share!" });

    const shareId = generateId();
    const now = Date.now();
    const query = `INSERT INTO shares (share_id, content, original_name, stored_name, created_at) VALUES (?, ?, ?, ?, ?)`;

    db.run(query, [shareId, content, file ? file.originalname : null, file ? file.filename : null, now], (err) => {
        if (err) return res.status(500).json({ error: err.message });

        // Build live URL dynamically
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const shareUrl = `${protocol}://${host}/?id=${shareId}`;

        res.json({ shareId, shareUrl });
    });
});

// 2. RETRIEVE (Check if < 24 Hours)
app.get('/api/share/:id', (req, res) => {
    const shareId = req.params.id;
    db.get(`SELECT * FROM shares WHERE share_id = ?`, [shareId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Item not found" });

        // Enforce 24-hour expiration (24 * 60 * 60 * 1000 ms)
        const TWENTY_FOUR_HOURS = 86400000;
        if (Date.now() - row.created_at > TWENTY_FOUR_HOURS) {
            return res.status(410).json({ error: "This QR code has expired (older than 24h)." });
        }

        res.json({
            content: row.content,
            fileName: row.original_name,
            fileUrl: row.stored_name ? `/files/${row.stored_name}` : null
        });
    });
});

// 3. BACKGROUND CLEANUP: Delete expired files every hour
setInterval(() => {
    const expiryCutoff = Date.now() - 86400000;
    db.all(`SELECT stored_name FROM shares WHERE created_at < ? AND stored_name IS NOT NULL`, [expiryCutoff], (err, rows) => {
        if (!err && rows) {
            rows.forEach(r => {
                const filePath = path.join(uploadDir, r.stored_name);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            });
            db.run(`DELETE FROM shares WHERE created_at < ?`, [expiryCutoff]);
        }
    });
}, 3600000); // Check every 60 minutes

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Quick-Share running on port ${PORT}`);
});