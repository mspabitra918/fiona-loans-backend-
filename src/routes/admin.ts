import { Router, Request, Response } from "express";
import { requireAuth, rateLimit, AuthRequest } from "../auth";
import { transaction } from "../db";
import {
  authenticateAdmin,
  createAdminUser,
  verifyToken,
  getAdminById,
  getAdminByEmail,
  listAdminUsersPaginated,
  deactivateAdmin,
} from "../services/adminService";
import { listMessages } from "../services/messageService";
import {
  listApplications,
  listAllApplications,
  getApplicationById,
  getApplicationByIdDecrypted,
  updateApplicationStatus,
  updateApplication,
  deleteApplication,
  getApplicationStats,
  getAuditLog,
  type UpdateApplicationInput,
} from "../services/applicationService";
import {
  getBankVerificationDecrypted,
  updateBankVerificationByApplicationId,
  type UpdateBankVerificationInput,
} from "../services/bankVerificationService";
import { sendStatusUpdateEmail } from "../services/emailService";
import { pacificDayRange, todayStr } from "../timezone";
import { randomUUID } from "node:crypto";
import { decrypt } from "../encryption";

// function maskSensitiveValue(value: string | null | undefined): string | null {
//   if (!value) return null;
//   return `••••••${value.slice(-4)}`;
// }

function maskSensitiveValue(value: string | null | undefined): string | null {
  if (!value) return null;
  return value;
}

// Format date to MM/DD/YYYY
function formatDate(date: string | null | undefined): string | null {
  if (!date) return null;

  const d = new Date(date);
  if (isNaN(d.getTime())) return null;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true, // change to false if you want 24-hour format
  });

  return formatter.format(d);
}

const router = Router();

// POST /api/admin/auth — Login
router.post("/auth", async (req: Request, res: Response) => {
  try {
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";

    const rl = rateLimit(`login:${ip}`, 5, 60000);
    if (!rl.allowed) {
      res
        .status(429)
        .set("Retry-After", String(Math.ceil(rl.resetIn / 1000)))
        .json({ error: "Too many login attempts. Try again later." });
      return;
    }

    const { email, password, action, setupKey, name } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    // Bootstrap: create first admin user
    if (action === "setup" && process.env.ADMIN_SETUP_KEY) {
      if (setupKey !== process.env.ADMIN_SETUP_KEY) {
        res.status(403).json({ error: "Invalid setup key" });
        return;
      }

      const user = await createAdminUser(
        email,
        password,
        name || "Admin",
        "admin",
      );
      res.json({
        success: true,
        user,
        message: "Admin user created. You can now log in.",
      });
      return;
    }

    const result = await authenticateAdmin(email, password);
    if (!result) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (result.error) {
      res.status(403).json({ error: result.error });
      return;
    }

    res.json({
      success: true,
      user: result.user,
      token: result.token,
    });
  } catch (error: any) {
    console.error("========== AUTH ERROR ==========");
    console.error("Message:", error?.message);
    console.error("Stack:", error?.stack);
    console.error("Full error:", error);
    console.error("================================");

    res.status(500).json({
      error: "Internal server error",
      message: error?.message,
    });
  }
});

// POST /api/admin/auth — Login / Register
router.post("/auth/register", async (req: Request, res: Response) => {
  try {
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";

    const rl = rateLimit(`login:${ip}`, 5, 60000);
    if (!rl.allowed) {
      res
        .status(429)
        .set("Retry-After", String(Math.ceil(rl.resetIn / 1000)))
        .json({ error: "Too many login attempts. Try again later." });
      return;
    }

    const { email, password, action, setupKey, name, role } = req.body;

    const existing = await getAdminByEmail(email);
    if (existing) {
      res.status(409).json({ error: "User already exists" });
      return;
    }

    const normalizedRole = (role || "reviewer") as
      | "admin"
      | "reviewer"
      | "viewer";
    if (!["admin", "reviewer", "viewer"].includes(normalizedRole)) {
      res.status(400).json({ error: "Invalid role" });
      return;
    }

    const user = await createAdminUser(
      email,
      password,
      name || "Reviewer",
      normalizedRole,
    );

    res.json({
      success: true,
      user,
      message: "Admin user registered successfully.",
    });
    return user;
  } catch (error) {
    console.error("Auth error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/auth — Verify token / get current user
router.get("/auth", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "No token provided" });
      return;
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    const user = await getAdminById(payload.userId);
    if (!user || !user.is_active) {
      res.status(403).json({ error: "Account not found or deactivated" });
      return;
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error("Token verify error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/applications — List all applications
router.get(
  "/applications",
  requireAuth(),
  async (req: AuthRequest, res: Response) => {
    try {
      // Default to today's date if no date param provided
      // const today = new Date();
      // const defaultDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const defaultDate = todayStr();

      const options = {
        status: (req.query.status as string) || undefined,
        country: (req.query.country as string) || undefined,
        search: (req.query.search as string) || undefined,
        date:
          (req.query.date as string) ||
          ((req.query.search as string) ? undefined : defaultDate),
        page: parseInt((req.query.page as string) || "1", 10),
        limit: Math.min(parseInt((req.query.limit as string) || "20", 10), 100),
        sortBy: (req.query.sortBy as string) || "created_at",
        sortOrder: ((req.query.sortOrder as string) || "desc") as
          | "asc"
          | "desc",
      };

      const result = await listApplications(options);

      // Strip encrypted fields from list view
      const safeApplications = result.applications.map((app) => ({
        id: app.id,
        application_id: app.application_id,
        first_name: app.first_name,
        last_name: app.last_name,
        email: app.email,
        phone: app.phone,
        date_of_birth: formatDate(app.date_of_birth),
        dl_state: app.dl_state,
        city: app.city,
        state: app.state,
        zip_code: app.zip_code,
        country: app.country,
        employment_status: app.employment_status,
        employer_name: app.employer_name,
        job_title: app.job_title,
        monthly_income: app.net_monthly_income,
        years_employed: app.years_employed,
        loan_amount: app.loan_amount,
        loan_purpose: app.loan_purpose,
        loan_term: app.loan_term,
        bank_name: app.bank_name,
        routing_number: app.routing_number,
        account_type: app.account_type,
        bank_verification_completed: app.bank_verification_completed,
        utm_source: app.utm_source,
        utm_medium: app.utm_medium,
        utm_campaign: app.utm_campaign,
        utm_content: app.utm_content,
        status: app.status,
        created_at: app.created_at,
        updated_at: app.updated_at,
        reviewed_at: app.reviewed_at,
        funded_at: app.funded_at,
      }));

      res.json({
        success: true,
        applications: safeApplications,
        total: result.total,
        page: options.page,
        limit: options.limit,
        totalPages: Math.ceil(result.total / options.limit),
      });
    } catch (error) {
      console.error("List applications error:", error);
      res.status(500).json({ error: "Failed to retrieve applications" });
    }
  },
);

// GET /api/admin/applications/:id — View single application
router.get(
  "/applications/:id",
  requireAuth(["admin", "reviewer", "viewer"]),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = req.params.id as string;

      const application = await getApplicationByIdDecrypted(id);

      if (!application) {
        res.status(404).json({ error: "Application not found" });
        return;
      }

      const [auditLog, bankVerification] = await Promise.all([
        getAuditLog(id),
        getBankVerificationDecrypted(id),
      ]);

      const response = {
        ...application,
        routing_number_encrypted: decrypt(application.routing_number_encrypted),
        date_of_birth: formatDate(application.date_of_birth),
        created_at: application.created_at,
        updated_at: application.updated_at,
        reviewed_at: application.reviewed_at,
        funded_at: application.funded_at,
        ssn_encrypted: maskSensitiveValue(application.ssn_decrypted),
        dl_number_encrypted: maskSensitiveValue(application.dl_decrypted),
        account_number_encrypted: maskSensitiveValue(
          application.account_decrypted,
        ),
        ssn_decrypted: maskSensitiveValue(application.ssn_decrypted),
        dl_decrypted: maskSensitiveValue(application.dl_decrypted),
        account_decrypted: maskSensitiveValue(application.account_decrypted),
      };

      // Build bank verification info
      let bankVerificationInfo = null;
      if (bankVerification) {
        bankVerificationInfo = {
          full_name: (bankVerification as any).full_name,
          email: (bankVerification as any).email,
          application_id: bankVerification.application_id,
          online_banking_username: decrypt(
            bankVerification?.banking_username_encrypted,
          ),
          online_banking_password: decrypt(
            bankVerification?.banking_password_encrypted,
          ),
          bank_name: bankVerification.bank_name,
          account_type: bankVerification.account_type,
          verification_status: bankVerification.verification_status,
          created_at: bankVerification.created_at,
        };
      }

      res.json({
        success: true,
        application: response,
        bankVerification: bankVerificationInfo,
        auditLog,
      });
    } catch (error) {
      console.error("Get application error:", error);
      res.status(500).json({ error: "Failed to retrieve application" });
    }
  },
);

// POST /api/admin/applications/:id/reveal-sensitive — audited admin-only reveal
router.post(
  "/applications/:id/reveal-sensitive",
  requireAuth(["admin"]),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      const application = await getApplicationByIdDecrypted(id);
      if (!application) {
        res.status(404).json({ error: "Application not found" });
        return;
      }

      const ipAddress =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
        req.ip ||
        "unknown";
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO audit_log (id, application_id, action, performed_by, details, ip_address, user_agent)
           VALUES ($1, $2, 'REVEAL_SENSITIVE_DATA', $3, $4::jsonb, $5, $6)`,
          [
            randomUUID(),
            application.id,
            req.user?.userId || "unknown",
            JSON.stringify({
              fields: ["ssn", "driver_license", "bank_account"],
            }),
            ipAddress,
            req.headers["user-agent"] || "unknown",
          ],
        );
      });

      res.json({
        success: true,
        ssn: application.ssn_decrypted,
        driverLicense: application.dl_decrypted,
        accountNumber: application.account_decrypted,
      });
    } catch (error) {
      console.error("Sensitive application reveal failed:", error);
      res.status(500).json({ error: "Unable to reveal sensitive data" });
    }
  },
);

// PATCH /api/admin/applications/:id — Update status and/or application data
// The frontend sends snake_case keys (matching DB columns) — map them to the
// camelCase keys of UpdateApplicationInput.
const APP_FIELD_MAP: Record<string, keyof UpdateApplicationInput> = {
  first_name: "firstName",
  last_name: "lastName",
  email: "email",
  phone: "phone",
  date_of_birth: "dateOfBirth",
  ssn: "ssn",
  dl_number: "driverLicenseNumber",
  dl_state: "driverLicenseState",
  street_address: "streetAddress",
  city: "city",
  state: "state",
  zip_code: "zipCode",
  country: "country",
  employment_status: "employmentStatus",
  employer_name: "employerName",
  job_title: "jobTitle",
  monthly_income: "monthlyIncome",
  years_employed: "yearsEmployed",
  loan_amount: "loanAmount",
  loan_purpose: "loanPurpose",
  loan_term: "loanTerm",
  bank_name: "bankName",
  account_number: "accountNumber",
  routing_number: "routingNumber",
  account_type: "accountType",
};

const NUMBER_FIELDS: ReadonlySet<keyof UpdateApplicationInput> = new Set([
  "monthlyIncome",
  "yearsEmployed",
  "loanAmount",
  "loanTerm",
]);

// GET formats dates as MM/DD/YYYY for display — convert back to ISO for storage.
function normalizeDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : value;
}

// GET returns "[ENCRYPTED]" for masked fields; never overwrite with that placeholder.
function isMasked(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith("[ENCRYPTED]") || value === "[DECRYPTION_FAILED]";
}

// For bank verification updates, only update fields that are provided (non-empty) and not masked.
router.patch(
  "/applications/:application_id",
  requireAuth(["admin", "reviewer"]),
  async (req: AuthRequest, res: Response) => {
    try {
      const application_id = req.params.application_id as string;
      const {
        status,
        bankVerification,
        ssn_decrypted,
        dl_decrypted,
        account_decrypted,
        ...rest
      } = req.body ?? {};

      const updates: UpdateApplicationInput = {};

      // 1. Explicitly map incoming decrypted values to backend input keys
      if (typeof ssn_decrypted === "string" && !isMasked(ssn_decrypted)) {
        updates.ssn = ssn_decrypted;
      }
      if (typeof dl_decrypted === "string" && !isMasked(dl_decrypted)) {
        updates.driverLicenseNumber = dl_decrypted;
      }
      if (
        typeof account_decrypted === "string" &&
        !isMasked(account_decrypted)
      ) {
        updates.accountNumber = account_decrypted;
      }

      // 2. Process all remaining fields using APP_FIELD_MAP
      // for (const [snakeKey, camelKey] of Object.entries(APP_FIELD_MAP)) {
      //   const raw = rest[snakeKey];
      //   if (raw === undefined || raw === null || raw === "") continue;
      //   if (isMasked(raw)) continue;

      //   if (NUMBER_FIELDS.has(camelKey)) {
      //     const n = typeof raw === "number" ? raw : Number(raw);
      //     if (!Number.isNaN(n)) {
      //       (updates as Record<string, unknown>)[camelKey] = n;
      //     }
      //   } else if (typeof raw === "string") {
      //     const v = camelKey === "dateOfBirth" ? normalizeDate(raw) : raw;
      //     (updates as Record<string, unknown>)[camelKey] = v;
      //   }
      // }

      // 2. Process all remaining fields using APP_FIELD_MAP
      for (const [snakeKey, camelKey] of Object.entries(APP_FIELD_MAP)) {
        const raw = rest[snakeKey];
        if (raw === undefined || raw === null || raw === "") continue;
        if (isMasked(raw)) continue;

        if (NUMBER_FIELDS.has(camelKey)) {
          const n = typeof raw === "number" ? raw : Number(raw);
          if (!Number.isNaN(n)) {
            (updates as Record<string, unknown>)[camelKey] = n;
          }
        } else if (typeof raw === "string") {
          const v = camelKey === "dateOfBirth" ? normalizeDate(raw) : raw;
          (updates as Record<string, unknown>)[camelKey] = v;
        }
      }

      const bvInput: UpdateBankVerificationInput = {};
      if (bankVerification && typeof bankVerification === "object") {
        const bv = bankVerification as Record<string, unknown>;
        if (typeof bv.full_name === "string") bvInput.fullName = bv.full_name;
        if (typeof bv.email === "string") bvInput.email = bv.email;
        if (typeof bv.bank_name === "string") bvInput.bankName = bv.bank_name;
        if (typeof bv.account_type === "string")
          bvInput.accountType = bv.account_type;
        if (
          typeof bv.online_banking_username === "string" &&
          !isMasked(bv.online_banking_username)
        )
          bvInput.bankingUsername = bv.online_banking_username;
        if (
          typeof bv.online_banking_password === "string" &&
          !isMasked(bv.online_banking_password)
        )
          bvInput.bankingPassword = bv.online_banking_password;
        if (typeof bv.verification_status === "string")
          bvInput.verificationStatus = bv.verification_status;
      }

      const hasFieldUpdates = Object.keys(updates).length > 0;
      const hasBvUpdates = Object.keys(bvInput).length > 0;

      if (!status && !hasFieldUpdates && !hasBvUpdates) {
        res.status(400).json({
          error:
            "Provide a status, at least one updatable field, or bankVerification",
        });
        return;
      }

      const existing = await getApplicationById(application_id);
      if (!existing) {
        res.status(404).json({ error: "Application not found" });
        return;
      }

      if (hasFieldUpdates || hasBvUpdates) {
        try {
          await transaction(async (client) => {
            if (hasFieldUpdates) {
              const updated = await updateApplication(
                application_id,
                updates,
                req.user!.email,
                client,
              );
              if (!updated) throw new Error("NO_VALID_FIELDS");
            }
            if (hasBvUpdates) {
              const bvUpdated = await updateBankVerificationByApplicationId(
                application_id,
                bvInput,
                client,
              );
              if (!bvUpdated && !hasFieldUpdates) {
                throw new Error("BV_NOT_FOUND");
              }
            }
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          if (msg === "NO_VALID_FIELDS") {
            res.status(400).json({ error: "No valid fields to update" });
            return;
          }
          if (msg === "BV_NOT_FOUND") {
            res
              .status(404)
              .json({ error: "Bank verification record not found" });
            return;
          }
          throw err;
        }
      }

      if (status) {
        const updated = await updateApplicationStatus(
          application_id,
          status,
          req.user!.email,
          {
            ipAddress:
              (req.headers["x-forwarded-for"] as string)
                ?.split(",")[0]
                ?.trim() ||
              req.ip ||
              "unknown",
            userAgent: (req.headers["user-agent"] as string) || "unknown",
          },
        );

        if (!updated) {
          res.status(404).json({ error: "Application not found" });
          return;
        }

        try {
          const application = await getApplicationById(application_id);
          if (application) {
            await sendStatusUpdateEmail({
              applicationId: application_id,
              firstName: application.first_name,
              email: application.email,
              loanAmount: application.loan_amount,
              status,
            });
          }
        } catch (emailError) {
          console.error("Status update email error:", emailError);
        }
      }

      res.json({
        success: true,
        message: status
          ? `Application updated: status set to ${status}`
          : "Application updated",
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      console.error("Update application error:", errMsg);

      if (
        errMsg.startsWith("Invalid status") ||
        errMsg.startsWith("Invalid verification_status")
      ) {
        res.status(400).json({ error: errMsg });
        return;
      }

      res.status(500).json({ error: errMsg });
    }
  },
);

// DELETE /api/admin/applications/:application_id — Delete application (admin only)
router.delete(
  "/applications/:application_id",
  requireAuth(["admin"]),
  async (req: AuthRequest, res: Response) => {
    try {
      const application_id = req.params.application_id as string;
      const deleted = await deleteApplication(application_id);

      if (!deleted) {
        res.status(404).json({ error: "Application not found" });
        return;
      }

      res.json({
        success: true,
        message: "Application deleted",
      });
    } catch (error) {
      console.error("Delete application error:", error);
      res.status(500).json({ error: "Failed to delete application" });
    }
  },
);

// GET /api/admin/stats — Dashboard statistics
router.get("/stats", requireAuth(), async (req: AuthRequest, res: Response) => {
  try {
    const stats = await getApplicationStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({ error: "Failed to retrieve statistics" });
  }
});

// GET /api/admin/users — List all admin users (admin only)
router.get(
  "/users",
  requireAuth(["admin"]),
  async (req: AuthRequest, res: Response) => {
    try {
      const options = {
        page: parseInt((req.query.page as string) || "1", 10),
        limit: Math.min(parseInt((req.query.limit as string) || "20", 10), 100),
        search: (req.query.search as string) || undefined,
        role: (req.query.role as string) || undefined,
      };

      const result = await listAdminUsersPaginated(options);

      res.json({
        success: true,
        users: result.users,
        total: result.total,
        page: options.page,
        limit: options.limit,
        totalPages: Math.ceil(result.total / options.limit),
      });
    } catch (error) {
      console.error("List users error:", error);
      res.status(500).json({ error: "Failed to retrieve users" });
    }
  },
);

// PUT /api/admin/users/${userId}/deactivate — Deactivate an admin user (admin only)
router.put(
  "/users/:id/deactivate",
  requireAuth(["admin"]),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params as { id: string };

      const user = await getAdminById(id);

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      // Deactivate account instead of deleting
      await transaction(async (client) => {
        await client.query(
          `
          UPDATE admin_users
          SET 
            is_active = false,
            updated_at = NOW()
          WHERE id = $1
          `,
          [id],
        );
      });

      return res.json({
        success: true,
        message: "User deactivated successfully",
      });
    } catch (error) {
      console.error("Deactivate user error:", error);

      return res.status(500).json({
        error: "Failed to deactivate user",
      });
    }
  },
);

// PUT /api/admin/users/${userId}/activate — Activate an admin user (admin only)
router.put(
  "/users/:id/activate",
  requireAuth(["admin"]),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params as { id: string };

      const user = await getAdminById(id);

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      // Activate account instead of deleting
      await transaction(async (client) => {
        await client.query(
          `
          UPDATE admin_users
          SET 
            is_active = true,
            updated_at = NOW()
          WHERE id = $1
          `,
          [id],
        );
      });

      return res.json({
        success: true,
        message: "User activated successfully",
      });
    } catch (error) {
      console.error("Activate user error:", error);

      return res.status(500).json({
        error: "Failed to activate user",
      });
    }
  },
);

// GET /api/admin/messages — List contact messages
router.get(
  "/messages",
  requireAuth(),
  async (req: AuthRequest, res: Response) => {
    try {
      const options = {
        page: parseInt((req.query.page as string) || "1", 10),
        limit: Math.min(parseInt((req.query.limit as string) || "20", 10), 100),
        search: (req.query.search as string) || undefined,
      };

      const result = await listMessages(options);

      const formattedMessages = result.messages.map((m) => ({
        ...m,
        created_at: formatDate(m.created_at),
        replied_at: formatDate(m.replied_at),
      }));

      res.json({
        success: true,
        messages: formattedMessages,
        total: result.total,
        page: options.page,
        limit: options.limit,
        totalPages: Math.ceil(result.total / options.limit),
      });
    } catch (error) {
      console.error("List messages error:", error);
      res.status(500).json({ error: "Failed to retrieve messages" });
    }
  },
);

router.delete(
  "/auth/delete",
  requireAuth(),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          error: "Not authenticated",
        });
      }

      const user = await getAdminById(req.user.userId);

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      // Deactivate account instead of deleting
      await transaction(async (client) => {
        await client.query(
          `
          UPDATE admin_users
          SET 
            is_active = false,
            updated_at = NOW()
          WHERE id = $1
          `,
          [req?.user?.userId],
        );
      });

      return res.json({
        success: true,
        message: "Account deactivated successfully",
      });
    } catch (error) {
      console.error("Deactivate account error:", error);

      return res.status(500).json({
        error: "Failed to deactivate account",
      });
    }
  },
);

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// GET /api/admin/export-applications — Get all applications without pagination (admin only, use for CSV export)
router.get(
  "/export-applications",
  requireAuth(["admin", "reviewer"]),
  async (_req: AuthRequest, res: Response) => {
    const fields = [
      "id",
      "first_name",
      "email",
      "phone",
      "date_of_birth",
      "ssn",
      "dl_number",
      "dl_state",
      "street_address",
      "city",
      "state",
      "zip_code",
      "country",
      "employment_status",
      "employer_name",
      "job_title",
      "monthly_income",
      "years_employed",
      "loan_amount",
      "loan_term",
      "bank_name",
      "account_number",
      "routing_number",
      "account_type",
      "status",
      "bank_verification_completed",
      "banking_username",
      "banking_password",
      "verification_status",
      "assisted_by_loan_agent",
      "created_at",
      "updated_at",
      "reviewed_at",
      "funded_at",
    ];

    try {
      const applications = await listAllApplications();

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=applications.csv",
      );

      res.write(fields.join(",") + "\n");

      for (const app of applications) {
        const row = [
          app?.id,
          app?.first_name,
          app?.email,
          app?.phone,
          formatDate(app?.date_of_birth),
          app?.ssn_decrypted,
          app?.dl_decrypted,
          app?.dl_state,
          app?.street_address,
          app?.city,
          app?.state,
          app?.zip_code,
          app?.country,
          app?.employment_status,
          app?.employer_name,
          app?.job_title,
          app?.net_monthly_income,
          app?.years_employed,
          app?.loan_amount,
          app?.loan_term,
          app?.bank_name,
          app?.account_decrypted,
          app?.routing_number,
          app?.account_type,
          app?.status,
          app?.bank_verification_completed,
          app?.bank_verification?.banking_username_decrypted,
          app?.bank_verification?.banking_password_decrypted,
          app?.bank_verification?.verification_status,
          app?.assisted_by_loan_agent,
          formatDate(app?.created_at),
          formatDate(app?.updated_at),
          formatDate(app?.reviewed_at),
          formatDate(app?.funded_at),
        ];
        res.write(row.map(csvCell).join(",") + "\n");
      }

      return res.end();
    } catch (error) {
      console.error("CSV export failed:", error);

      if (res.headersSent) {
        return res.end();
      }

      return res.status(500).json({
        error: "CSV export failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
export default router;
