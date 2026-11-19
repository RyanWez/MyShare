const fs = require("fs");
const { Pool } = require("pg");

if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is missing.");
    process.exit(1);
  }
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.delete("sslmode");
  const pool = new Pool({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log("=== USERS ===");
    const users = await pool.query(
      "SELECT u.id, u.username, r.name AS role, rg.name AS rex, u.is_active FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN rex_groups rg ON rg.id = u.rex_id ORDER BY u.id"
    );
    console.table(users.rows);

    console.log("\n=== SIMS (latest 15) ===");
    const sims = await pool.query(
      "SELECT s.phone, rg.name AS rex, s.balance, s.status, s.bill_expire_at FROM sims s LEFT JOIN rex_groups rg ON rg.id = s.rex_id ORDER BY s.updated_at DESC LIMIT 15"
    );
    console.table(sims.rows);

    console.log("\n=== TRANSFERS (latest 10) ===");
    const transfers = await pool.query(
      "SELECT id, sender_phone, receiver_phone, amount, fee, status, error_code FROM transfers ORDER BY id DESC LIMIT 10"
    );
    console.table(transfers.rows);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
