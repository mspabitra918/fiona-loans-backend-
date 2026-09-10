import { Router, Request, Response } from "express";
import { z } from "zod";
import { rateLimit } from "../auth";
import { applicationSchema, sanitizeInput } from "../validation";
import {
  createApplication,
  checkDuplicateSSN,
  saveApplicationStep,
  findMatchingApplication,
  findRecentDecline,
  runMlaCoveredBorrowerCheck,
  runSoftPullPrequalification,
} from "../services/applicationService";
import { trackLeadEvent } from "../services/metaCapi";
import { sendApplicationConfirmationEmail } from "../services/emailService";
import { sendDiscordNotification } from "../services/discordService";
import { enqueueDripSequence } from "../queue/dripQueue";

const router = Router();

const stepSubmissionSchema = z.object({
  sessionId: z.string().min(1).optional(),
  step: z.number().int().min(1).max(3),
  data: z.object({}).passthrough().default({}),
});

router.post("/steps", async (req: Request, res: Response) => {
  try {
    const parsed = stepSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return res.status(400).json({
        error: firstIssue?.message || "Invalid application step payload",
        field: firstIssue?.path[0],
      });
    }

    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";

    const { sessionId, step, data } = parsed.data;
    const userAgent = (req.headers["user-agent"] as string) || "unknown";
    const resolvedSessionId = sessionId || crypto.randomUUID();
    const stepData: Record<string, unknown> = { ...data };

    if (step === 1) {
      const identity = {
        email: String(data.email || ""),
        phone: String(data.mobilePhone || data.phone || ""),
        dateOfBirth: String(data.dob || data.dateOfBirth || ""),
        lastName: String(data.lastName || ""),
      };

      const recentDecline = await findRecentDecline(identity);
      if (recentDecline) {
        return res.status(409).json({
          error:
            "This applicant is not eligible to reapply until 90 days after the prior decision.",
          status: "declined",
        });
      }

      const duplicate = await findMatchingApplication(
        identity,
        resolvedSessionId,
      );
      if (duplicate) {
        return res.status(409).json({
          error:
            "An application with these contact and identity details already exists.",
          applicationId: duplicate.applicationId,
          status: duplicate.status,
        });
      }

      const prequal = runSoftPullPrequalification(data);
      stepData.prequalDecision = prequal.decision;
      stepData.prequalReason = prequal.reason;
    }

    if (step === 2) {
      const mla = await runMlaCoveredBorrowerCheck({
        firstName: String(data.firstName || ""),
        lastName: String(data.lastName || ""),
        dateOfBirth: String(data.dob || data.dateOfBirth || ""),
        ssn: String(data.ssn || ""),
      });

      stepData.mlaCheckRequired = mla.required;
      stepData.mlaCoveredBorrower = mla.coveredBorrower;
      if (mla.coveredBorrower) {
        stepData.prequalDecision = "declined";
        stepData.prequalReason = "mla_covered_borrower";
      }
    }

    const savedApplication = await saveApplicationStep({
      sessionId: resolvedSessionId,
      step,
      data: stepData,
      ipAddress: ip,
      userAgent,
      pageUrl: req.headers.referer || "",
    });

    if (step === 1 && savedApplication.status === "prequalified") {
      sendApplicationConfirmationEmail({
        applicationId: savedApplication.applicationId,
        firstName: String(stepData.firstName || "Applicant"),
        lastName: String(stepData.lastName || ""),
        email: String(stepData.email || ""),
        loanAmount: Number(stepData.loanAmount || 0),
        loanPurpose: String(stepData.loanPurpose || "Loan application"),
        loanTerm: Number(stepData.loanTerm || 0),
        resumeUrl: `${process.env.FRONTEND_URL || ""}/apply?resume=${encodeURIComponent(resolvedSessionId)}`,
        status: "pending",
      }).catch((error) => {
        console.error("Application confirmation email failed:", error);
      });
    }

    return res.status(200).json({
      success: true,
      applicationId: savedApplication.applicationId,
      status: savedApplication.status,
      derivedData: savedApplication.derivedData,
      step,
      sessionId: resolvedSessionId,
      message: "Application step saved successfully.",
    });
  } catch (error) {
    console.error("Application step save failed:", error);
    return res.status(500).json({
      error: "Failed to save application step.",
    });
  }
});

// POST /api/apply — Submit loan application
// router.post("/", async (req: Request, res: Response) => {
//   try {
//     const ip =
//       (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
//       req.ip ||
//       "unknown";
//     // Validate request body
//       if (isDuplicate) {
//         res.status(409).json({
//           error:
//             "An application with this SSN already exists. Please contact support if you need to update your application.",
//         });
//         return;
//       }
//     } catch (dbError) {
//       console.warn(
//         "Database not available, skipping duplicate check:",
//         dbError,
//       );
//     }

//     // Insert into database
//     let applicationId: string;
//     try {
//       const result = await createApplication({
//         firstName: body.firstName,
//         lastName: body.lastName,
//         email: body.email,
//         phone: body.phone,
//         dateOfBirth: body.dateOfBirth,
//         ssn: body.ssn,
//         driverLicenseNumber: body.driverLicenseNumber,
//         driverLicenseState: body.driverLicenseState,
//         streetAddress: body.streetAddress,
//         city: body.city,
//         state: body.state,
//         zipCode: body.zipCode,
//         country: body.country,
//         employmentStatus: body.employmentStatus,
//         employerName: body.employerName,
//         jobTitle: body.jobTitle,
//         monthlyIncome: body.monthlyIncome,
//         yearsEmployed: body.yearsEmployed,
//         loanAmount: body.loanAmount,
//         loanPurpose: body.loanPurpose,
//         loanTerm: body.loanTerm,
//         bankName: body.bankName,
//         accountNumber: body.accountNumber,
//         routingNumber: body.routingNumber,
//         bankAccountAge: body.bankAccountAge,
//         bankBalanceStatus: body.bankBalanceStatus,
//         accountType: body.accountType,
//         utmSource: body.utmSource,
//         utmMedium: body.utmMedium,
//         utmCampaign: body.utmCampaign,
//         utmContent: body.utmContent,
//         assistedByLoanAgent: body.assistedByLoanAgent,
//         tcpaConsent: true,
//         privacyConsent: true,
//         creditCheckConsent: true,
//         ipAddress: ip,
//         userAgent,
//         leadId: body.leadId,
//       });
//       applicationId = result.id;
//       res.json({
//         success: true,
//         applicationId,
//         status: "bank_verification_pending",
//         message:
//           "Application submitted successfully. Bank verification is in progress.",
//       });
//     } catch (dbError) {
//       console.error("Database insert failed:", dbError);
//       res
//         .status(500)
//         .json({ error: "Failed to process application. Please try again." });
//       return;
//     }

//     // Send confirmation email
//     try {
//       await sendApplicationConfirmationEmail({
//         applicationId,
//         firstName: body.firstName,
//         lastName: body.lastName,
//         email: body.email,
//         loanAmount: body.loanAmount,
//         loanPurpose: body.loanPurpose,
//         loanTerm: body.loanTerm,
//       });
//     } catch (err) {
//       console.error("Email send error:", err);
//     }

//     // Start the bank-verification drip sequence. New applications begin in
//     // `bank_verification_pending`; enqueueDripSequence never throws so a queue
//     // outage cannot block submission.
//     try {
//       await enqueueDripSequence(applicationId, new Date());
//     } catch (err) {
//       console.error("Drip sequence error:", err);
//     }

//     // Send Discord notification
//     try {
//       await sendDiscordNotification(
//         `📋 **New Loan Application**\n` +
//           `**Name:** ${body.firstName} ${body.lastName}\n` +
//           `**Email:** ${body.email}\n` +
//           `**Phone:** ${body.phone}\n` +
//           `**Loan Amount:** $${body.loanAmount}\n` +
//           `**Loan Purpose:** ${body.loanPurpose}\n` +
//           `**Loan Term:** ${body.loanTerm} months\n` +
//           `**Application ID:** ${applicationId}`,
//       );
//     } catch (err) {
//       console.error("Discord notification error:", err);
//     }

//     // Fire Meta CAPI event
//     try {
//       await trackLeadEvent({
//         email: body.email,
//         phone: body.phone,
//         firstName: body.firstName,
//         lastName: body.lastName,
//         ipAddress: ip,
//         userAgent,
//         loanAmount: body.loanAmount,
//         loanPurpose: body.loanPurpose,
//         sourceUrl: req.headers.referer || undefined,
//       });
//     } catch (err) {
//       console.error("Meta CAPI error:", err);
//     }

//     console.log(`Application submitted: ${applicationId}`);
//   } catch (error) {
//     console.error("Application submission error:", error);
//     res
//       .status(500)
//       .json({ error: "An internal error occurred. Please try again." });
//   }
// });

router.post("/", async (req: Request, res: Response) => {
  try {
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";

    // Validate request body
    const parsed = applicationSchema.safeParse(req.body);

    if (!parsed.success) {
      const firstError = parsed.error.issues[0];

      return res.status(400).json({
        error: firstError?.message || "Invalid input",
        field: firstError?.path[0],
      });
    }

    const body = parsed.data;
    const userAgent = (req.headers["user-agent"] as string) || "unknown";

    // Check duplicate SSN
    try {
      const isDuplicate = await checkDuplicateSSN(body.ssn);

      if (isDuplicate) {
        return res.status(409).json({
          error:
            "An application with this SSN already exists. Please contact support if you need to update your application.",
        });
      }
    } catch (dbError) {
      console.warn(
        "Database not available, skipping duplicate check:",
        dbError,
      );
    }

    // Save application
    let applicationId: string;

    try {
      const result = await createApplication({
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        dateOfBirth: body.dateOfBirth,

        ssn: body.ssn,
        driverLicenseNumber: body.driverLicenseNumber,
        driverLicenseState: body.driverLicenseState,

        streetAddress: body.streetAddress,
        city: body.city,
        state: body.state,
        zipCode: body.zipCode,
        country: body.country,

        employmentStatus: body.employmentStatus,
        employerName: body.employerName,
        jobTitle: body.jobTitle,
        monthlyIncome: body.monthlyIncome,
        yearsEmployed: body.yearsEmployed,

        loanAmount: body.loanAmount,
        loanPurpose: body.loanPurpose,
        loanTerm: body.loanTerm,

        bankName: body.bankName,
        accountNumber: body.accountNumber,
        routingNumber: body.routingNumber,
        bankAccountAge: body.bankAccountAge,
        bankBalanceStatus: body.bankBalanceStatus,
        accountType: body.accountType,

        utmSource: body.utmSource,
        utmMedium: body.utmMedium,
        utmCampaign: body.utmCampaign,
        utmContent: body.utmContent,

        assistedByLoanAgent: body.assistedByLoanAgent,

        tcpaConsent: true,
        privacyConsent: true,
        creditCheckConsent: true,

        ipAddress: ip,
        userAgent,

        leadId: body.leadId,
      });

      applicationId = result.id;
    } catch (dbError) {
      console.error("Database insert failed:", dbError);

      return res.status(500).json({
        error: "Failed to process application. Please try again.",
      });
    }

    // ===============================
    // Return response immediately
    // ===============================

    res.json({
      success: true,
      applicationId,
      status: "bank_verification_pending",
      message:
        "Application submitted successfully. Bank verification is in progress.",
    });

    // ===============================
    // Background tasks
    // ===============================

    // Confirmation Email
    sendApplicationConfirmationEmail({
      applicationId,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      loanAmount: body.loanAmount,
      loanPurpose: body.loanPurpose,
      loanTerm: body.loanTerm,
       status: "pending",
    }).catch((err) => {
      console.error("Email send error:", err);
    });

    // Bank verification drip sequence
    enqueueDripSequence(applicationId, new Date()).catch((err) => {
      console.error("Drip sequence error:", err);
    });

    // Discord notification
    sendDiscordNotification(
      `📋 **New Loan Application**
**Name:** ${body.firstName} ${body.lastName}
**Email:** ${body.email}
**Phone:** ${body.phone}
**Loan Amount:** $${body.loanAmount}
**Loan Purpose:** ${body.loanPurpose}
**Loan Term:** ${body.loanTerm} months
**Application ID:** ${applicationId}`,
    ).catch((err) => {
      console.error("Discord notification error:", err);
    });

    // Meta CAPI event
    trackLeadEvent({
      email: body.email,
      phone: body.phone,
      firstName: body.firstName,
      lastName: body.lastName,
      ipAddress: ip,
      userAgent,
      loanAmount: body.loanAmount,
      loanPurpose: body.loanPurpose,
      sourceUrl: req.headers.referer || undefined,
    }).catch((err) => {
      console.error("Meta CAPI error:", err);
    });

    console.log(`Application submitted: ${applicationId}`);
  } catch (error) {
    console.error("Application submission error:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "An internal error occurred. Please try again.",
      });
    }
  }
});

export default router;
