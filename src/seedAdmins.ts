import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "./db";

const admins = [
  {
    email: "pabitraghara384@gmail.com",
    password: "admin",
    name: "Pabitra",
    role: "reviewer",
  },
  {
    email: "alex@fionaloans.com",
    password: "Alex_Secure_2024!",
    name: "Alex",
    role: "reviewer",
  },
  {
    email: "kevin@fionaloans.com",
    password: "Kevin_Viewer_99#",
    name: "Kevin",
    role: "viewer",
  },
  {
    email: "max@fionaloans.com",
    password: "Max_Strong_P@ss_01",
    name: "Max",
    role: "reviewer",
  },
  {
    email: "david@fionaloans.com",
    password: "david@ss_01",
    name: "David",
    role: "admin",
  },
] as const;

async function seedAdmins() {
  try {
    console.log("🌱 Starting admin seeder...\n");

    for (const admin of admins) {
      const email = admin.email.trim().toLowerCase();

      console.log(`Checking ${email}...`);

      const existing = await pool.query(
        `
        SELECT id
        FROM admin_users
        WHERE LOWER(email) = $1
        LIMIT 1
        `,
        [email],
      );

      // Hash password
      const passwordHash = await bcrypt.hash(admin.password, 12);

      if (existing.rows.length > 0) {
        // Update existing admin
        await pool.query(
          `
          UPDATE admin_users
          SET
            email = $1,
            password_hash = $2,
            name = $3,
            role = $4,
            is_active = true,
            updated_at = NOW()
          WHERE id = $5
          `,
          [email, passwordHash, admin.name, admin.role, existing.rows[0].id],
        );

        console.log(`✓ Updated ${email}`);
      } else {
        // Create new admin
        await pool.query(
          `
          INSERT INTO admin_users (
            email,
            password_hash,
            name,
            role,
            is_active,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, true, NOW(), NOW())
          `,
          [email, passwordHash, admin.name, admin.role],
        );

        console.log(`✓ Created ${email}`);
      }
    }

    console.log("\n✅ Admin seeding completed successfully!");
  } catch (error) {
    console.error("\n❌ Admin seeding failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seedAdmins();
