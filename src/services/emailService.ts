interface ApplicationDetails {
  applicationId: string;
  firstName: string;
  lastName: string;
  email: string;
  loanAmount: number;
  loanPurpose: string;
  loanTerm: number;
  status?: string;
}

import { sendEmail as sendMailerCloudEmail } from "./mailercloudService";

type EmailSender = typeof sendMailerCloudEmail;

let emailSender: EmailSender = sendMailerCloudEmail;

/** Test seam: swap the underlying transport. Pass no argument to restore it. */
export function setEmailSender(sender?: EmailSender): void {
  emailSender = sender ?? sendMailerCloudEmail;
}

export async function sendMailgunEmail(
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const missing = [
    ["SMTP_HOST", process.env.SMTP_HOST],
    ["SMTP_USER", process.env.SMTP_USER],
    ["SMTP_PASS", process.env.SMTP_PASS],
    [
      "MAILERCLOUD_FROM_EMAIL or FROM_EMAIL",
      process.env.MAILERCLOUD_FROM_EMAIL || process.env.FROM_EMAIL,
    ],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Status email is not configured; missing: ${missing.join(", ")}. Configure MailerCloud SMTP credentials in the backend .env.`,
    );
  }

  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  await emailSender({ to, subject, html, text });
}

/**
 * Statuses an application holds before it has reached bank verification. The
 * verification link is withheld for these — the applicant has not finished the
 * wizard, so there is nothing to verify against yet.
 */
const PRE_BANK_VERIFICATION_STATUSES = new Set([
  "draft",
  "prequalified",
  "identity_verified",
]);

export async function sendApplicationConfirmationEmail(
  details: ApplicationDetails,
): Promise<void> {
  const { applicationId, firstName, email, loanAmount } = details;

  const formattedAmount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(loanAmount);

  const previewText =
    "Your application is pre-approved. Complete bank verification to continue.";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <!-- Hidden Email Preview Text -->
      <div style="display:none;font-size:1px;color:#333333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        ${previewText}
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

      <!-- Main Body -->
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 30px; border-radius: 0 0 8px 8px;">
        <p style="color: #374151; font-size: 16px; margin-top: 0;">
          Hi ${firstName},
        </p>

        <p style="color: #374151; font-size: 16px;">
          Your loan application has been received and pre-approved.
        </p>

        <!-- Summary Details Card -->
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

        <p style="color: #374151; font-size: 16px;">
          Your next step is to verify your bank account.
        </p>

        <!-- CTA Button -->
        <div style="text-align: center; margin: 30px 0;">
          <a
            href="${process.env.FRONTEND_URL}/verify-bank?applicationId=${applicationId}"
            style="
              background: #1a56db;
              color: #ffffff;
              padding: 14px 32px;
              border-radius: 6px;
              text-decoration: none;
              font-size: 16px;
              font-weight: bold;
              display: inline-block;
              letter-spacing: 0.5px;
            "
          >
            VERIFY MY BANK
          </a>
        </div>

        <p style="color: #374151; font-size: 16px;">
          Complete your verification to continue your application.
        </p>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 25px 0;">

        <!-- Contact & Support Footer -->
        <div style="text-align: center; padding: 10px 0;">
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Phone:</strong> <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a>
          </p>
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Email:</strong> <a href="mailto:support@fionaloans.com" style="color: #1a56db; text-decoration: none;">support@fionaloans.com</a>
          </p>
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Website:</strong> <a href="https://www.fionaloans.com" style="color: #1a56db; text-decoration: none;">www.fionaloans.com</a>
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

  await sendMailgunEmail(
    email,
    `Your application is pre-approved. Complete bank verification to continue - ID: ${applicationId} | Fiona Loans`,
    html,
  );
}

interface StatusUpdateDetails {
  applicationId: string;
  firstName: string;
  email: string;
  loanAmount: number;
  status: string;
  fundedAt?: string | Date; // Pass stored funding timestamp
}

const statusConfig: Record<
  string,
  {
    title: string;
    message?: string;
    color: string;
    icon: string;
    subject?: string;
    customBody?: (
      details: StatusUpdateDetails,
      formattedAmount: string,
    ) => string;
  }
> = {
  bank_verification_pending: {
    title: "Bank Verification Required",
    subject: "Action Required: Securely verify your bank account",
    message:
      "Your loan application has been received. Please complete the bank verification process to proceed with your application.",
    customBody: (details) => `
      <p style="color: #374151; font-size: 16px;">Hi ${details.firstName},</p>
      <p style="color: #374151; font-size: 16px;">We are currently reviewing your Fiona Loans application! To proceed further and generate your final loan agreement, we need to verify your active bank account details.</p>
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 20px 0;">
        <h3 style="color: #111827; margin-top: 0; margin-bottom: 12px;">Your Security is Our Priority:</h3>
        <ul style="color: #374151; font-size: 15px; padding-left: 18px; margin: 0; line-height: 1.6;">
          <li><strong>Bank-Level Security:</strong> Your data is protected by 256-bit SSL encryption, the same standard used by major financial institutions.</li>
          <li><strong>Strictly Confidential:</strong> We adhere strictly to GLBA and financial privacy laws. Your information is used exclusively for verifying your identity and funding your approved loan.</li>
          <li><strong>Read-Only Access:</strong> We only verify your account status and balance. We cannot make changes to your bank account.</li>
        </ul>
      </div>
      <p style="color: #374151; font-size: 16px;">If you need assistance, please call our underwriting team at <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a>.</p>
      <p style="color: #374151; font-size: 16px; margin-top: 24px;">Best regards,<br/>The Underwriting Team at Fiona Loans</p>
    `,
    color: "#f59e0b",
    icon: "&#127974;",
  },
  bank_verification_in_progress: {
    title: "Bank Verification In Progress",
    message:
      "Your bank verification is currently being processed. Please allow some time for us to verify your bank account details. We will notify you once the verification is complete.",
    color: "#2563eb",
    icon: "&#9203;",
  },
  bank_verification_completed: {
    title: "Bank Verification Completed",
    message:
      "Your bank verification has been successfully completed. Your application is now being prepared for review by our team.",
    color: "#16a34a",
    icon: "&#9989;",
  },
  bank_verification_failed: {
    title: "Bank Verification Failed",
    message:
      "Unfortunately, we were unable to verify your bank account. Please re-submit your bank verification with correct credentials to continue with your loan application.",
    color: "#dc2626",
    icon: "&#9888;",
  },
  bank_reverification: {
    title: "Bank connection unsuccessful",
    subject: "Action Required: Bank connection unsuccessful",
    message: "",
    customBody: (details) => `
      <p style="color: #374151; font-size: 16px;">Hi ${details.firstName},</p>
      <p style="color: #374151; font-size: 16px;">We received a notification that your recent attempt to securely link your bank account was unsuccessful.</p>
      <p style="color: #374151; font-size: 16px;">This usually happens if the login credentials entered were incorrect, or if there was a timeout with your bank's multi-factor authentication (like a text message code).</p>
      <p style="color: #374151; font-size: 16px;">To keep your application moving, please click the secure link below to try logging into your financial institution again. Please ensure you are using your most up-to-date online banking username and password.</p>
      <p style="color: #374151; font-size: 16px;">If you continue to have trouble, or if you would like to connect a different bank account, please call us immediately at <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a> so we can assist you.</p>
      <p style="color: #374151; font-size: 16px; margin-top: 24px;">Best,<br/>Fiona Loans Customer Support</p>
    `,
    color: "#dc2626",
    icon: "&#128273;",
  },
  request_a_call: {
    title: "Urgent Action Needed",
    subject: "URGENT: Please call Fiona Loans immediately",
    message: "",
    customBody: (details) => `
      <p style="color: #374151; font-size: 16px;">Hi ${details.firstName},</p>
      <p style="color: #374151; font-size: 16px;">Something urgent has come up regarding your loan application. We need to speak with you directly before we can move any further in the approval process.</p>
      <p style="color: #374151; font-size: 16px;"><strong>Please call us ASAP at <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a>.</strong></p>
      <p style="color: #374151; font-size: 16px;">Our underwriting team is standing by to resolve this with you quickly so we can get your file back on track.</p>
      <p style="color: #374151; font-size: 16px;"><em>Hours: Monday – Friday, 06:00 AM – 04:00 PM PST</em></p>
      <p style="color: #374151; font-size: 16px; margin-top: 24px;">Best,<br/>The Underwriting Team at Fiona Loans</p>
    `,
    color: "#dc2626",
    icon: "&#128222;",
  },
  reviewing: {
    title: "Application Under Review",
    message:
      "Your loan application is currently being reviewed by our team. We will notify you once a decision has been made.",
    color: "#2563eb",
    icon: "&#128269;",
  },
  approved: {
    title: "Application Approved!",
    message:
      "Congratulations! Your loan application has been approved. Our team will be in touch shortly with the next steps to finalize your loan.",
    color: "#16a34a",
    icon: "&#9989;",
  },
  funded: {
    title: "Loan Funded",
    subject: "Your loan has been funded",
    color: "#16a34a",
    icon: "&#9989;",
    customBody: (details, formattedAmount) => {
      // Convert funding timestamp to Pacific Time (America/Los_Angeles)
      const dateObj = details.fundedAt
        ? new Date(details.fundedAt)
        : new Date();

      const fundedDate = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
      }).format(dateObj);

      const fundedTime = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(dateObj);

      return `
        <p style="color: #374151; font-size: 16px;">Hi ${details.firstName},</p>
        <p style="color: #374151; font-size: 16px;">Good news — your loan has been funded.</p>
        <p style="color: #374151; font-size: 16px;">
          <strong>Loan Amount:</strong> ${formattedAmount}<br/>
          <strong>Application ID:</strong> ${details.applicationId}<br/>
          <strong>Funded On:</strong> ${fundedDate} at ${fundedTime} Pacific Time
        </p>
        <p style="color: #374151; font-size: 16px;">
          Your funds have been released. Please allow up to 24 business hours for the funds to appear in your bank account.
        </p>
        <p style="color: #374151; font-size: 16px;">
          If you have any questions, please contact us:<br/>
          <strong>Phone:</strong> <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a><br/>
          <strong>Email:</strong> <a href="mailto:support@fionaloans.com" style="color: #1a56db; text-decoration: none;">support@fionaloans.com</a>
        </p>
        <p style="color: #374151; font-size: 16px; margin-top: 24px;">
          Thank you,<br/>
          Fiona Loans Support
        </p>
      `;
    },
  },

  declined: {
    title: "Application Status",
    subject: "Update regarding your loan application",
    color: "#dc2626",
    icon: "&#10060;",
    customBody: (details, formattedAmount) => `
      <p style="color: #374151; font-size: 16px;">Hi ${details.firstName},</p>
      <p style="color: #374151; font-size: 16px;">
        We’re writing to let you know that your loan application has been declined at this time.
      </p>
      <p style="color: #374151; font-size: 16px;">
        <strong>Application ID:</strong> ${details.applicationId}<br/>
        <strong>Loan Amount:</strong> ${formattedAmount}
      </p>
      <p style="color: #374151; font-size: 16px;">
        This decision applies to your current application. If you have questions about your application or need additional information, please contact our support team.
      </p>
      <p style="color: #374151; font-size: 16px;">
        <strong>Phone:</strong> <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a><br/>
        <strong>Email:</strong> <a href="mailto:support@fionaloans.com" style="color: #1a56db; text-decoration: none;">support@fionaloans.com</a>
      </p>
      <p style="color: #374151; font-size: 16px; margin-top: 24px;">
        Thank you,<br/>
        Fiona Loans Support
      </p>
    `,
  },
  pending: {
    title: "Application Pending",
    message:
      "Your application is now pending review. Our team will begin reviewing your application shortly.",
    color: "#f59e0b",
    icon: "&#9203;",
  },
  declined_pb: {
    title: "Update Required: Unsupported bank account type",
    subject: "Update Required: Unsupported bank account type",
    message: "",
    customBody: (details) => `
      <p style="color: #374151; font-size: 16px;">Hi ${details.firstName},</p>
      <p style="color: #374151; font-size: 16px;">Thank you for submitting your loan application.</p>
      
      <p style="color: #374151; font-size: 16px;">
        After reviewing the banking information provided, we’re unable to proceed with your application at this time because the account provided is with a prepaid banking service and does not meet the current bank-account eligibility requirements for this application.
      </p>

      <p style="color: #374151; font-size: 16px;">
        To be eligible to proceed, you must have an active local bank account that has been open for at least 90 days.
      </p>

      <p style="color: #374151; font-size: 16px;">
        <strong>Application ID:</strong> ${details.applicationId}<br/>
        <strong>Loan Amount:</strong> $${details.loanAmount}
      </p>

      <p style="color: #374151; font-size: 16px;">
        If you have an eligible local bank account that meets this requirement, please contact us to discuss the next steps:
      </p>

      <p style="color: #374151; font-size: 16px;">
        Phone: <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a><br/>
        Email: <a href="mailto:support@fionaloans.com" style="color: #1a56db; text-decoration: none;">support@fionaloans.com</a>
      </p>

      <p style="color: #374151; font-size: 16px; margin-top: 24px;">
        Thank you,<br/>
        Fiona Loans Support
      </p>
    `,
    color: "#dc2626",
    icon: "&#9888;",
  },
  declined_hd: {
    title: "Notice of Action: Your loan application status",
    subject: "Notice of Action: Your loan application status",
    message: "",
    customBody: (details) => `
    <p style="color: #374151; font-size: 16px;">Hi ${details.firstName},</p>
    <p style="color: #374151; font-size: 16px;">Thank you for submitting your loan application.</p>
    
    <p style="color: #374151; font-size: 16px;">
      After completing the underwriting review, the lender has determined that your application does not meet its current credit and risk assessment criteria. As a result, we are unable to approve the application at this time.
    </p>

    <p style="color: #374151; font-size: 16px;">
      <strong>Application ID:</strong> ${details.applicationId}<br/>
      <strong>Requested Loan Amount:</strong> $${details.loanAmount}
    </p>

    <p style="color: #374151; font-size: 16px;">
      This decision is based on the lender’s assessment of the application and its applicable underwriting requirements.
    </p>

    <p style="color: #374151; font-size: 16px;">
      If you have questions regarding your application or the decision, please contact our support team:
    </p>

    <p style="color: #374151; font-size: 16px;">
      Phone: <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a><br/>
      Email: <a href="mailto:support@fionaloans.com" style="color: #1a56db; text-decoration: none;">support@fionaloans.com</a>
    </p>

    <p style="color: #374151; font-size: 16px; margin-top: 24px;">
      Thank you,<br/>
      Fiona Loans Support
    </p>
  `,
    color: "#dc2626",
    icon: "&#10060;",
  },
  verification_deposit_1: {
    title: "Finalize Verification Deposit",
    subject: "ACTION REQUIRED: Finalize your Fiona Loans verification deposit",
    message: "",
    customBody: (details) => `
      <p style="color: #374151; font-size: 16px;">Hello ${details.firstName},</p>
      <p style="color: #374151; font-size: 16px;">Thank you for choosing Fiona Loans. We are pleased to inform you that the initial phase of your bank verification has been successfully completed.</p>
      <p style="color: #374151; font-size: 16px;">Because Fiona Loans specializes in providing financial opportunities to borrowers with diverse financial backgrounds—including those working to rebuild credit scores, stabilize repayment histories, or manage high debt-to-income ratios—our security protocol requires a final confirmation step before your full loan can be disbursed.</p>
      <h3 style="color: #111827; margin-top: 20px;">YOUR NEXT STEPS:</h3>
      <ol style="color: #374151; font-size: 16px; padding-left: 20px;">
        <li style="margin-bottom: 10px;"><strong>Monitor Your Account (Within 24 Hours)</strong><br/>Fiona Loans will issue a dynamic security deposit between $99.00 and $1,999.00 into your connected bank account.</li>
        <li style="margin-bottom: 10px;"><strong>Call Your Loan Officer</strong><br/>As soon as these funds are fully cleared and available in your balance, please immediately call your dedicated Loan Officer to confirm the exact amount received.</li>
        <li style="margin-bottom: 10px;"><strong>Return the Security Deposit</strong><br/>To complete the verification cycle and release your full loan funding, our security policy requires you to return this exact deposit amount to us. For your convenience, this can be completed instantly via Cash App, Apple Pay, or in person at a local merchant near you (including CVS, Walgreens, and Walmart).</li>
      </ol>
      <div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 15px; margin: 20px 0;">
        <p style="color: #92400e; font-size: 14px; margin: 0;"><strong>Please Note:</strong> Your full loan disbursement is temporarily on hold until this verification deposit is safely processed and settled.</p>
      </div>
      <p style="color: #374151; font-size: 16px;">If you have any questions or need help finding a nearby payment location, our support team is standing by to assist you.</p>
      <p style="color: #374151; font-size: 16px;">Best regards,<br/>The Fiona Loans Verifications Team<br/>Direct Support: (747) 200-5930</p>
    `,
    color: "#2563eb",
    icon: "&#128176;",
  },
  verification_deposit_2: {
    title: "Re-verification Deposit Required",
    subject:
      "URGENT: Re-verification deposit required for your Fiona Loans loan",
    message: "",
    customBody: (details) => `
      <p style="color: #374151; font-size: 16px;">Hello ${details.firstName},</p>
      <p style="color: #374151; font-size: 16px;">We are contacting you because our automated compliance system was unable to clear your initial bank account validation.</p>
      <h3 style="color: #111827; margin-top: 20px;">REASON FOR RE-VERIFICATION:</h3>
      <p style="color: #374151; font-size: 16px;">Our processing network flagged a secure connection timeout or a routing variance during the first transaction attempt. Because Fiona Loans works directly with borrowers who have challenging credit profiles or high debt-to-income ratios, our data-matching and anti-fraud protocols are exceptionally strict. To protect your identity and secure your file, a secondary validation must be completed immediately.</p>
      <p style="color: #374151; font-size: 16px;">We have initiated a new, secondary verification deposit to override the previous error.</p>
      <h3 style="color: #111827; margin-top: 20px;">YOUR MANDATORY NEXT STEPS:</h3>
      <ol style="color: #374151; font-size: 16px; padding-left: 20px;">
        <li style="margin-bottom: 10px;"><strong>Monitor Your Account (Within 24 Hours)</strong><br/>Fiona Loans has issued a new, randomized security deposit between $99.00 and $1,999.00 into your connected bank account.</li>
        <li style="margin-bottom: 10px;"><strong>Call Your Loan Officer Immediately</strong><br/>As soon as you see this specific new amount clear in your available balance, call your dedicated Loan Officer right away to verify the exact digits. Do not use the previous deposit figures, as they are now expired and voided.</li>
        <li style="margin-bottom: 10px;"><strong>Return the Re-Verification Deposit</strong><br/>To clear the security flag on your profile and release your pending loan funding, you must return this exact new deposit amount to us. You can complete this instantly via Cash App, Apple Pay, or in person at a local retail merchant near you (including CVS, Walgreens, and Walmart).</li>
      </ol>
      <div style="background: #fee2e2; border: 1px solid #ef4444; border-radius: 8px; padding: 15px; margin: 20px 0;">
        <p style="color: #991b1b; font-size: 14px; margin: 0;"><strong>Important Notice:</strong> Your loan approval cannot be maintained indefinitely while in a flagged state. Your full loan disbursement remains heavily on hold, and failure to complete this secondary step within 48 hours will result in the automatic expiration of your application.</p>
      </div>
      <p style="color: #374151; font-size: 16px;">If you need help identifying the new deposit or locating a nearby payment node, call our specialized verification line immediately.</p>
      <p style="color: #374151; font-size: 16px;">Best regards,<br/>The Fiona Loans Verifications Team<br/>Direct Support: (747) 200-5930</p>
    `,
    color: "#dc2626",
    icon: "&#9888;",
  },
  upfront_needed: {
    title: "Processing Update",
    subject:
      "Action Required: Processing update for your Fiona Loans application",
    message: "",
    customBody: (details, formattedAmount) => `
      <p style="color: #374151; font-size: 16px;">Hello ${details.firstName},</p>
      <p style="color: #374151; font-size: 16px;">Thank you for submitting your application for a loan of ${formattedAmount}. Your application is currently on hold under Application ID: ${details.applicationId}.</p>
      <p style="color: #374151; font-size: 16px;">Because your primary account is with an online banking institution, our automated system cannot fully verify your financial details. To move your application forward, our underwriting team must perform a manual review. This process involves manually auditing your bank statements, pulling and analyzing your credit report, and drafting the formal approval documentation required to fund your loan.</p>
      <p style="color: #374151; font-size: 16px;">To cover the additional administrative resources required for this manual review, a one-time processing fee of $200.00 is required before we can proceed.</p>
      <p style="color: #374151; font-size: 16px;">If you would like to move forward with this processing method, please call your dedicated Loan Officer at your earliest convenience to arrange the payment and finalize your application.</p>
      <p style="color: #374151; font-size: 16px;">Best regards,<br/>The Fiona Loans Verifications Team<br/>Direct Support: (747) 200-5930</p>
    `,
    color: "#f59e0b",
    icon: "&#128176;",
  },
  deposit_in_progress: {
    title: "Verification Deposit In Process",
    message:
      "A micro-deposit has been initiated to your bank account. Please check your bank statement in 1-2 business days for the deposit amounts and come back to verify them.",
    color: "#f59e0b",
    icon: "&#128176;",
  },
};

// export async function sendStatusUpdateEmail(
//   details: StatusUpdateDetails,
// ): Promise<void> {
//   const { applicationId, firstName, email, loanAmount, status } = details;

//   const config = statusConfig[status];
//   if (!config) return;

//   const formattedAmount = new Intl.NumberFormat("en-US", {
//     style: "currency",
//     currency: "USD",
//   }).format(loanAmount);

//   const statusLabel =
//     status === "verification_deposit_1"
//       ? "Verification Deposit in Progress"
//       : status === "verification_deposit_2"
//         ? "Re-Verification Deposit In Progress"
//         : status === "upfront_needed"
//           ? "Waiting for Fee Payment"
//           : status === "bank_reverification"
//             ? "Bank Re-Verification"
//             : status === "request_a_call"
//               ? "Request a Call"
//               : status === "declined_pb"
//                 ? "Declined - PB"
//                 : status === "declined_hd"
//                   ? "Declined - HD"
//                   : status.replace(/_/g, " ").toUpperCase();

//   const subject =
//     config.subject || `${config.title} - ID: ${applicationId} | Fiona Loans`;

//   const messageHtml = config.customBody
//     ? config.customBody(details, formattedAmount)
//     : `
//         <p style="color: #374151; font-size: 16px;">
//           Hi ${firstName},
//         </p>
//         <p style="color: #374151; font-size: 16px;">
//           ${config.message}
//         </p>
//       `;

//   const html = `
//     <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
//       <div style="background: #F0FFF4; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
//   <h1
//     style="
//       margin: 0;
//       font-size: 32px;
//       font-weight: 700;
//       color: #14532d;
//       font-family: Arial, Helvetica, sans-serif;
//       letter-spacing: 0.5px;
//     "
//   >
//     Fiona Loans
//   </h1>
// </div>
//       <div style="border: 1px solid #e5e7eb; border-top: none; padding: 30px; border-radius: 0 0 8px 8px;">
//         <div style="text-align: center; margin-bottom: 20px;">
//           <span style="font-size: 48px;">${config.icon}</span>
//         </div>
//         <h2 style="color: ${config.color}; margin-top: 0; text-align: center;">${config.title}</h2>
//         ${messageHtml}
//         <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; margin: 20px 0;">
//           <table style="width: 100%; border-collapse: collapse;">
//             <tr>
//               <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Application ID</td>
//               <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: bold; text-align: right;">${applicationId}</td>
//             </tr>
//             <tr>
//               <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Loan Amount</td>
//               <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: bold; text-align: right;">${formattedAmount}</td>
//             </tr>
//           </table>
//         </div>
//         <p style="color: #374151; font-size: 14px;">
//           You can check your application status at any time using your Application ID <strong>${applicationId}</strong>.
//         </p>
//         ${
//           [
//             "bank_verification_failed",
//             "bank_verification_pending",
//             "bank_reverification",
//           ].includes(status)
//             ? `<div style="text-align: center; margin: 25px 0;">
//           <a href="${process.env.FRONTEND_URL}/verify-bank?applicationId=${applicationId}" style="background: #1a56db; color: #ffffff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-size: 16px; font-weight: bold; display: inline-block;">${status === "bank_verification_pending" ? "Click Here to Securely Verify Your Bank" : status === "bank_reverification" ? "Securely Re-Link My Bank Account" : "Verify Bank Account"}</a>
//         </div>`
//             : ""
//         }
//         <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
//         <div style="text-align: center; padding: 10px 0;">
//           <p style="color: #374151; font-size: 14px; margin: 5px 0;">
//             <strong>Phone:</strong> <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a>
//           </p>
//           <p style="color: #374151; font-size: 14px; margin: 5px 0;">
//             <strong>Website:</strong> <a href="https://www.fionaloans.com" style="color: #1a56db; text-decoration: none;">www.fionaloans.com</a>
//           </p>
//         </div>
//         <p style="color: #9ca3af; font-size: 12px; text-align: center;">
//           This is an automated email from Fiona Loans. Please do not reply to this email.
//         </p>
//       </div>
//     </div>
//   `;

//   await sendMailgunEmail(email, subject, html);
// }

export async function sendStatusUpdateEmail(
  details: StatusUpdateDetails,
): Promise<void> {
  const { applicationId, firstName, email, loanAmount, status } = details;

  const config = statusConfig[status];
  if (!config) return;

  const formattedAmount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(loanAmount);

  // Set Preview Text based on status
  const previewText =
    status === "funded"
      ? "Your loan has been funded. Please allow up to 24 business hours for the funds to appear in your bank account."
      : status === "declined"
        ? "We have an update regarding your loan application."
        : "";

  const subject =
    config.subject || `${config.title} - ID: ${applicationId} | Fiona Loans`;

  const messageHtml = config.customBody
    ? config.customBody(details, formattedAmount)
    : `
        <p style="color: #374151; font-size: 16px;">
          Hi ${firstName},
        </p>
        <p style="color: #374151; font-size: 16px;">
          ${config.message}
        </p>
      `;

  // Render Status-Specific Call to Action (CTA) Buttons
  let ctaButtonHtml = "";
  if (status === "funded") {
    ctaButtonHtml = `
      <div style="text-align: center; margin: 25px 0;">
        <a href="${process.env.FRONTEND_URL}/loan-status?applicationId=${applicationId}&email=${email}" style="background: #16a34a; color: #ffffff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-size: 16px; font-weight: bold; display: inline-block;">
          VIEW APPLICATION STATUS
        </a>
      </div>
    `;
  } else if (status === "declined") {
    ctaButtonHtml = `
      <div style="text-align: center; margin: 25px 0;">
        <a href="mailto:support@fionaloans.com" style="background: #1a56db; color: #ffffff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-size: 16px; font-weight: bold; display: inline-block;">
          CONTACT SUPPORT
        </a>
      </div>
    `;
  } else if (
    [
      "bank_verification_failed",
      "bank_verification_pending",
      "bank_reverification",
    ].includes(status)
  ) {
    ctaButtonHtml = `
      <div style="text-align: center; margin: 25px 0;">
        <a href="${process.env.FRONTEND_URL}/verify-bank?applicationId=${applicationId}" style="background: #1a56db; color: #ffffff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-size: 16px; font-weight: bold; display: inline-block;">
          ${status === "bank_verification_pending" ? "Click Here to Securely Verify Your Bank" : status === "bank_reverification" ? "Securely Re-Link My Bank Account" : "Verify Bank Account"}
        </a>
      </div>
    `;
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <!-- Hidden Email Preview Text -->
      ${
        previewText
          ? `<div style="display:none;font-size:1px;color:#333333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${previewText}</div>`
          : ""
      }
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
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 30px; border-radius: 0 0 8px 8px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <span style="font-size: 48px;">${config.icon}</span>
        </div>
        <h2 style="color: ${config.color}; margin-top: 0; text-align: center;">${config.title}</h2>
        
        ${messageHtml}

        ${ctaButtonHtml}

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
        <div style="text-align: center; padding: 10px 0;">
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Phone:</strong> <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a>
          </p>
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Email:</strong> <a href="mailto:support@fionaloans.com" style="color: #1a56db; text-decoration: none;">support@fionaloans.com</a>
          </p>
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Website:</strong> <a href="https://www.fionaloans.com" style="color: #1a56db; text-decoration: none;">www.fionaloans.com</a>
          </p>
        </div>
        <p style="color: #9ca3af; font-size: 12px; text-align: center;">
          This is an automated email from Fiona Loans. Please do not reply to this email.
        </p>
      </div>
    </div>
  `;

  await sendMailgunEmail(email, subject, html);
}

export interface PostBankVerificationEmailDetails {
  applicationId: string;
  firstName: string;
  email: string;
  loanAmount: number;
}

export async function sendPostBankVerificationEmail(
  details: PostBankVerificationEmailDetails,
): Promise<void> {
  const { applicationId, firstName, email, loanAmount } = details;

  const formattedAmount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(loanAmount);

  const previewText =
    "Your bank verification is complete. Call us to complete the next step.";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <!-- Hidden Email Preview Text -->
      <div style="display:none;font-size:1px;color:#333333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        ${previewText}
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

      <!-- Main Body -->
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 30px; border-radius: 0 0 8px 8px;">
        <p style="color: #374151; font-size: 16px; margin-top: 0;">
          Hi ${firstName},
        </p>

        <p style="color: #374151; font-size: 16px;">
          Your bank verification is complete.
        </p>

        <p style="color: #374151; font-size: 16px;">
          Your loan has been approved, but it is not yet ready for funding. Please call us to confirm your application and complete the required voice verification.
        </p>

        <!-- CTA Button -->
        <div style="text-align: center; margin: 30px 0;">
          <a
            href="tel:+17472005930"
            style="
              background: #1a56db;
              color: #ffffff;
              padding: 14px 32px;
              border-radius: 6px;
              text-decoration: none;
              font-size: 16px;
              font-weight: bold;
              display: inline-block;
              letter-spacing: 0.5px;
            "
          >
            CALL (747) 200-5930
          </a>
        </div>

        <p style="color: #374151; font-size: 16px;">
          After verification, you will be connected with our underwriting team to review and electronically sign your loan agreement.
        </p>

        <!-- Summary Details Card -->
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

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 25px 0;">

        <!-- Contact & Support Footer -->
        <div style="text-align: center; padding: 10px 0;">
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Phone:</strong> <a href="tel:+17472005930" style="color: #1a56db; text-decoration: none;">(747) 200-5930</a>
          </p>
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Email:</strong> <a href="mailto:support@fionaloans.com" style="color: #1a56db; text-decoration: none;">support@fionaloans.com</a>
          </p>
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Website:</strong> <a href="https://www.fionaloans.com" style="color: #1a56db; text-decoration: none;">www.fionaloans.com</a>
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

  await sendMailgunEmail(
    email,
    `Your bank verification is complete. Call us to complete the next step - ID: ${applicationId} | Fiona Loans`,
    html,
  );
}
