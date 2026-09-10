import nodemailer from "nodemailer";

/**
 * ============================================================
 * SMTP CONFIGURATION
 * ============================================================
 *
 * Port 465 = TLS from the beginning
 *
 * We are intentionally NOT using STARTTLS here.
 * This avoids the STARTTLS handshake issue you are seeing
 * on Vercel with port 587.
 */

const smtpHost = process.env.SMTP_HOST;
const smtpPort = 465;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;

const fromEmail = process.env.FROM_EMAIL || process.env.MAILERCLOUD_FROM_EMAIL;

const fromName =
  process.env.FROM_NAME || process.env.MAILERCLOUD_FROM_NAME || "Fiona Loans";

const campaignId = process.env.MAILERCLOUD_CAMPAIGN_ID;

/**
 * ============================================================
 * SAFE CONFIGURATION LOG
 * ============================================================
 *
 * Never log SMTP_PASS.
 */

console.log("");
console.log("================================================");
console.log("📧 EMAIL SERVICE INITIALIZING");
console.log("================================================");

console.log("SMTP_HOST:", smtpHost || "❌ MISSING");
console.log("SMTP_PORT:", smtpPort);
console.log("SMTP_SECURE:", true);
console.log("SMTP_USER:", smtpUser || "❌ MISSING");
console.log("SMTP_PASS:", smtpPass ? "✅ SET" : "❌ MISSING");
console.log("FROM_EMAIL:", fromEmail || "❌ MISSING");
console.log("FROM_NAME:", fromName);
console.log("CAMPAIGN_ID:", campaignId ? "✅ SET" : "NOT SET");

console.log("================================================");
console.log("");

/**
 * ============================================================
 * CREATE TRANSPORTER
 * ============================================================
 *
 * Port 465:
 *
 *   secure: true
 *   requireTLS: false
 *
 * TLS starts immediately.
 */

const transporter = nodemailer.createTransport({
  host: smtpHost,

  port: 465,

  secure: true,

  requireTLS: false,

  auth: {
    user: smtpUser,
    pass: smtpPass,
  },

  /**
   * Timeout settings
   */
  connectionTimeout: 30_000,
  greetingTimeout: 30_000,
  socketTimeout: 60_000,

  /**
   * Temporary debugging.
   *
   * After fixing the issue, change these to false.
   */
  logger: true,
  debug: true,
});

/**
 * ============================================================
 * SEND EMAIL
 * ============================================================
 */

export async function sendEmail({
  to,
  subject,
  html,
  text,
  campaignId: customCampaignId,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  campaignId?: string;
}) {
  console.log("");
  console.log("================================================");
  console.log("📨 SEND EMAIL START");
  console.log("================================================");

  console.log("To:", to);
  console.log("Subject:", subject);
  console.log("HTML length:", html?.length || 0);
  console.log("Text length:", text?.length || 0);

  /**
   * ==========================================================
   * 1. VALIDATE ENVIRONMENT VARIABLES
   * ==========================================================
   */

  const missing: string[] = [];

  if (!smtpHost) {
    missing.push("SMTP_HOST");
  }

  if (!smtpUser) {
    missing.push("SMTP_USER");
  }

  if (!smtpPass) {
    missing.push("SMTP_PASS");
  }

  if (!fromEmail) {
    missing.push("FROM_EMAIL or MAILERCLOUD_FROM_EMAIL");
  }

  if (missing.length > 0) {
    console.error("");
    console.error("❌ EMAIL CONFIGURATION ERROR");

    console.error("Missing:", missing.join(", "));

    console.error("");

    throw new Error(`Email is not configured; missing: ${missing.join(", ")}`);
  }

  console.log("✅ Email environment variables validated");

  /**
   * ==========================================================
   * 2. CAMPAIGN / TRACKING HEADERS
   * ==========================================================
   */

  const finalCampaignId = customCampaignId || campaignId;

  const headers = finalCampaignId
    ? {
        "mld-track-campaign-id": finalCampaignId,

        "mld-track-opens": "true",

        "mld-track-clicks": "true",

        "mld-track-inbox": "true",
      }
    : undefined;

  console.log("Tracking:", headers ? "✅ ENABLED" : "DISABLED");

  /**
   * ==========================================================
   * 3. FROM ADDRESS
   * ==========================================================
   */

  const from = `"${fromName}" <${fromEmail}>`;

  console.log("From:", from);

  /**
   * ==========================================================
   * 4. VERIFY SMTP CONNECTION
   * ==========================================================
   */

  console.log("");
  console.log("🔌 Testing SMTP connection...");
  console.log("SMTP Host:", smtpHost);
  console.log("SMTP Port:", smtpPort);
  console.log("SMTP Secure:", true);
  console.log("Connection type:", "Implicit TLS");

  const verifyStart = Date.now();

  try {
    await transporter.verify();

    const verifyDuration = Date.now() - verifyStart;

    console.log("");
    console.log("✅ SMTP CONNECTION VERIFIED");

    console.log("Verification time:", `${verifyDuration}ms`);
  } catch (error: any) {
    console.error("");
    console.error("================================================");
    console.error("❌ SMTP CONNECTION FAILED");
    console.error("================================================");

    console.error("Name:", error?.name);

    console.error("Message:", error?.message);

    console.error("Code:", error?.code);

    console.error("Command:", error?.command);

    console.error("Response:", error?.response);

    console.error("Response Code:", error?.responseCode);

    console.error("Errno:", error?.errno);

    console.error("Syscall:", error?.syscall);

    console.error("Address:", error?.address);

    console.error("Port:", error?.port);

    console.error("Stack:", error?.stack);

    console.error("================================================");

    throw error;
  }

  /**
   * ==========================================================
   * 5. SEND EMAIL
   * ==========================================================
   */

  console.log("");
  console.log("📤 Sending email through SMTP...");

  const sendStart = Date.now();

  try {
    const info = await transporter.sendMail({
      from,

      to,

      subject,

      html,

      text,

      headers,
    });

    const sendDuration = Date.now() - sendStart;

    /**
     * ========================================================
     * 6. SUCCESS
     * ========================================================
     */

    console.log("");
    console.log("================================================");

    console.log("✅ EMAIL SENT SUCCESSFULLY");

    console.log("================================================");

    console.log("To:", to);

    console.log("Message ID:", info.messageId);

    console.log("SMTP Response:", info.response);

    console.log("Accepted:", info.accepted);

    console.log("Rejected:", info.rejected);

    console.log("Pending:", info.pending);

    console.log("Send duration:", `${sendDuration}ms`);

    console.log("================================================");

    console.log("");

    return info;
  } catch (error: any) {
    /**
     * ========================================================
     * 7. SEND ERROR
     * ========================================================
     */

    console.error("");
    console.error("================================================");

    console.error("❌ EMAIL SEND FAILED");

    console.error("================================================");

    console.error("To:", to);

    console.error("Subject:", subject);

    console.error("");
    console.error("--- ERROR ---");

    console.error("Name:", error?.name);

    console.error("Message:", error?.message);

    console.error("Code:", error?.code);

    console.error("Command:", error?.command);

    console.error("Response:", error?.response);

    console.error("Response Code:", error?.responseCode);

    console.error("Errno:", error?.errno);

    console.error("Syscall:", error?.syscall);

    console.error("Address:", error?.address);

    console.error("Port:", error?.port);

    console.error("");
    console.error("--- SMTP CONFIG ---");

    console.error("Host:", smtpHost);

    console.error("Port:", smtpPort);

    console.error("Secure:", true);

    console.error("User:", smtpUser);

    console.error("Password:", smtpPass ? "SET" : "MISSING");

    console.error("From:", from);

    console.error("");
    console.error("--- STACK ---");

    console.error(error?.stack);

    console.error("");
    console.error("================================================");

    throw error;
  }
}
