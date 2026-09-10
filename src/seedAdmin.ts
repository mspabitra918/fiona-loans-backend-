import "dotenv/config";
import { createAdminUser, updateAdminPassword } from "./services/adminService";
import { pool } from "./db";

const admins = [
  {
    email: "pabitraghara384@gmail.com",
    password: "admin",
    name: "Pabitra",
    role: "reviewer",
  },
  {
    email: "alex@brookloans.com",
    password: "Alex_Secure_2024!",
    name: "Alex",
    role: "reviewer",
  },
  {
    email: "kevin@brookloans.com",
    password: "Kevin_Viewer_99#",
    name: "Kevin",
    role: "viewer",
  },
  {
    email: "max@brookloans.com",
    password: "Max_Strong_P@ss_01",
    name: "Max",
    role: "reviewer",
  },
  {
    email: "david@brookloans.com",
    password: "david@ss_01",
    name: "David",
    role: "admin",
  },
] as const;

async function seed() {
  try {
    for (const admin of admins) {
      console.log(`Checking ${admin.email}...`);

      const { rows } = await pool.query(
        "SELECT id FROM admin_users WHERE email = $1",
        [admin.email],
      );

      if (rows.length > 0) {
        await updateAdminPassword(rows[0].id, admin.password);
        console.log(`✓ Updated password for ${admin.email}`);
      } else {
        await createAdminUser(
          admin.email,
          admin.password,
          admin.name,
          admin.role,
        );
        console.log(`✓ Created ${admin.email}`);
      }
    }

    console.log("\n✅ Admin seeding completed!");
  } catch (error) {
    console.error("❌ Failed to seed admins:", error);
  } finally {
    await pool.end();
  }
}

seed();
