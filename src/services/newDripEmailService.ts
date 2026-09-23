import { sendMailgunEmail } from "./emailService";

export interface DripEmailDetails {
  applicationId: string;
  firstName: string;
  email: string;
  loanAmount: number;
}

type CtaTarget = "verify" | "phone" | "home";

interface DripTemplate {
  subject: string;
  previewText: string;
  accent: string;
  body: string[];
  cta: { label: string; target: CtaTarget };
  signOff: string[];
}

const VERIFY_PATH = "/verify-bank";
const PHONE_DISPLAY = "(747) 200-5930";
const PHONE_HREF = "tel:+17472005930";
const HOME_URL = "https://www.fionaloans.com";

const PHONE_LINK = `<a href="${PHONE_HREF}" style="color: #1a56db; text-decoration: none;">${PHONE_DISPLAY}</a>`;
const EMAIL_LINK = `<a href="mailto:support@fionaloans.com" style="color: #1a56db; text-decoration: none;">support@fionaloans.com</a>`;

// 3. Follow-Up #1 — 6 Hours
const FOLLOWUP_6H: DripTemplate = {
  subject: "Reminder: Complete Your Bank Verification",
  previewText: "Please complete bank verification to finish your application.",
  accent: "#1a56db",
  body: [
    "Your loan application is still waiting for bank verification.",
    "Please complete your verification to continue.",
    "If verification is not completed within 2 days, your application may be cancelled.",
  ],
  cta: { label: "VERIFY MY BANK", target: "verify" },
  signOff: [],
};

// 4. Follow-Up #2 — 24 Hours
const FOLLOWUP_24H: DripTemplate = {
  subject: "Your Bank Verification is Still Incomplete",
  previewText: "Complete your bank verification to continue your application.",
  accent: "#1a56db",
  body: [
    "Your bank verification is still incomplete.",
    "Please complete verification to continue your loan application.",
  ],
  cta: { label: "VERIFY MY BANK", target: "verify" },
  signOff: [],
};

// 5. Follow-Up #3 — 48 Hours
const FOLLOWUP_48H: DripTemplate = {
  subject: "Final Reminder: Verify Your Bank Account",
  previewText: "Final reminder: your bank verification is still pending.",
  accent: "#1a56db",
  body: [
    "This is your final reminder to complete your bank verification.",
    "Your application is still pending verification.",
    "If verification is not completed, your application will be cancelled for now.",
  ],
  cta: { label: "VERIFY MY BANK", target: "verify" },
  signOff: [],
};

// 5. Follow-Up #3 — 72 Hours
// 6. Application Cancelled
const APPLICATION_CANCELLED: DripTemplate = {
  subject: "Notice: Your Loan Application Has Been Cancelled",
  previewText:
    "Your application was cancelled because bank verification was not completed.",
  accent: "#1a56db",
  body: [
    "Your loan application has been cancelled for now because bank verification was not completed.",
    "You can contact us within 30 days if you would like to request that your application be reopened.",
  ],
  cta: { label: `CALL ${PHONE_DISPLAY}`, target: "phone" },
  signOff: [],
};

const TEMPLATES: Record<number, DripTemplate> = {
  1: FOLLOWUP_6H,
  2: FOLLOWUP_24H,
  3: FOLLOWUP_48H,
  4: APPLICATION_CANCELLED,
};

function ctaHref(target: CtaTarget, applicationId: string): string {
  switch (target) {
    case "verify":
      return `${process.env.FRONTEND_URL || HOME_URL}${VERIFY_PATH}?applicationId=${applicationId}`;
    case "phone":
      return PHONE_HREF;
    case "home":
      return process.env.FRONTEND_URL || HOME_URL;
  }
}

function renderDripEmail(
  template: DripTemplate,
  details: DripEmailDetails,
): string {
  const { applicationId, firstName, loanAmount } = details;

  const formattedAmount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(loanAmount);

  const paragraphs = template.body
    .map(
      (p) =>
        `<p style="color: #374151; font-size: 16px; line-height: 1.5;">${p}</p>`,
    )
    .join("\n");

  const signOffText = template.signOff.length
    ? `<p style="color: #374151; font-size: 16px; margin-top: 24px;">${template.signOff.join("<br />\n")}</p>`
    : "";

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <!-- Hidden Email Preview Text -->
      <div style="display:none;font-size:1px;color:#333333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        ${template.previewText}
      </div>

      <!-- Header Banner -->
      <div style="background: #F0FFF4; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1
          style="
            margin: 0;
            font-size: 32px;
            font-weight: 700;
            color: #14532d;
            font-family: Arial, Helvetica, sans-serif;
            letter-spacing: 0.5px;
          "
        >
          Fiona Loans
        </h1>
      </div>

      <!-- Content Container -->
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 30px; border-radius: 0 0 8px 8px;">
        <p style="color: #374151; font-size: 16px; margin-top: 0;">Hi ${firstName},</p>
        
        ${paragraphs}

        <!-- CTA Button -->
        <div style="text-align: center; margin: 25px 0;">
          <a href="${ctaHref(template.cta.target, applicationId)}" style="background: ${template.accent}; color: #ffffff; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-size: 16px; font-weight: bold; display: inline-block; letter-spacing: 0.5px;">
            ${template.cta.label}
          </a>
        </div>

        ${signOffText}

        <!-- Application Summary Card -->
        <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Application ID</td>
              <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: bold; text-align: right;">${applicationId}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Loan Amount</td>
              <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: bold; text-align: right;">${formattedAmount}</td>
            </tr>
          </table>
        </div>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">

        <!-- Support Footer -->
        <div style="text-align: center; padding: 10px 0;">
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Phone:</strong> ${PHONE_LINK}
          </p>
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Email:</strong> ${EMAIL_LINK}
          </p>
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Website:</strong> <a href="${HOME_URL}" style="color: #1a56db; text-decoration: none;">www.fionaloans.com</a>
          </p>
          <p style="color: #374151; font-size: 14px; margin-top: 15px; font-weight: bold;">
            Fiona Loans Support
          </p>
        </div>

        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-bottom: 0;">
          This is an automated email from Fiona Loans. Please do not reply to this email.
        </p>
      </div>
    </div>
  `;
}

/**
 * Sends drip email #`emailNumber`. The caller (worker) is responsible for the
 * kill-switch check and idempotency before invoking this.
 */
export async function sendNewDripEmail(
  emailNumber: number,
  details: DripEmailDetails,
): Promise<void> {
  const template = TEMPLATES[emailNumber];

  if (!template) {
    throw new Error(`No drip template for email #${emailNumber}`);
  }

  console.log("[drip-email] details:", {
    emailNumber,
    applicationId: details.applicationId,
    email: details.email,
  });

  const html = renderDripEmail(template, details);

  await sendMailgunEmail(details.email, template.subject, html);
}
