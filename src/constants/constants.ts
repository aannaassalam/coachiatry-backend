import { Document } from "mongoose";

export const ROLES = {
    ADMIN: "admin",
    USER: "user",
};

export const RESPONSES = {
    SUCCESS: "SUCCESS",
    ERROR: "ERROR",
};

export const ADMIN_EMAILS = [
    {
        name: "admin",
        email: "biswaruprx21",
    },
];

export const PARSER_OTP = "987234";

export const smsTemplates = {};
export const RESPONSE_MESSAGES = {};

export const PASSWORD_HTML = (name: string, password: string) => {
    return `
   <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f7f7f9; padding: 32px;">
      <div style="max-width: 480px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px;">
         <div style="text-align: center; margin-bottom: 24px;">
            <img src="https://i.imgur.com/1Q9Z1Zl.png" alt="health care Logo" style="height: 48px; margin-bottom: 8px;" />
            <h2 style="color: #1e88e5; margin: 0;">Welcome to health care</h2>
         </div>
         <p style="font-size: 16px; color: #222;">Dear <strong>${name}</strong>,</p>
         <p style="font-size: 15px; color: #444;">Your password is:</p>
         <div style="background: #e3f2fd; color: #1565c0; font-size: 18px; font-weight: bold; padding: 12px 0; border-radius: 6px; text-align: center; margin: 16px 0;">
            ${password}
         </div>
         <p style="font-size: 14px; color: #555;">Please keep it safe and do not share it with anyone.</p>
         <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
         <p style="font-size: 14px; color: #888; text-align: right; margin: 0;">
            Best regards,<br/>
            <span style="color: #1e88e5; font-weight: 600;">health care Team</span>
         </p>
      </div>
   </div>
   `;
};

export const contactUsHTML = (
    name: string,
    email: string,
    phone?: string,
    companyName?: string,
    message?: string
) => {
    return `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f7f7f9; padding: 32px;">
         <div style="max-width: 480px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px;">
            <div style="text-align: center; margin-bottom: 24px;">
               <img src="https://i.imgur.com/1Q9Z1Zl.png" alt="health care Logo" style="height: 48px; margin-bottom: 8px;" />
               <h2 style="color: #1e88e5; margin: 0;">Contact Us Submission</h2>
            </div>
            <p style="font-size: 16px; color: #222;">You have received a new contact request:</p>
            <table style="width: 100%; font-size: 15px; color: #444; margin: 16px 0;">
               <tr>
                  <td style="font-weight: bold; padding: 6px 0;">Name:</td>
                  <td>${name}</td>
               </tr>
               <tr>
                  <td style="font-weight: bold; padding: 6px 0;">Email:</td>
                  <td>${email}</td>
               </tr>
               ${
                   phone
                       ? `<tr>
                  <td style="font-weight: bold; padding: 6px 0;">Phone:</td>
                  <td>${phone}</td>
               </tr>`
                       : ""
               }
               ${
                   companyName
                       ? `<tr>
                  <td style="font-weight: bold; padding: 6px 0;">Company:</td>
                  <td>${companyName}</td>
               </tr>`
                       : ""
               }
            </table>
            <div style="margin: 20px 0;">
               <div style="font-weight: bold; color: #1565c0; margin-bottom: 8px;">Message:</div>
               <div style="background: #e3f2fd; color: #222; font-size: 15px; padding: 16px; border-radius: 6px;">
                  ${message || ""}
               </div>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
            <p style="font-size: 14px; color: #888; text-align: right; margin: 0;">
               <span style="color: #1e88e5; font-weight: 600;">Team</span>
            </p>
         </div>
      </div>
   `;
};

export const RESET_LINK_HTML = (name: string, link: string) => {
    return `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f7f7f9; padding: 32px;">
    <div style="max-width: 480px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <img src="https://coachiatry.s3.us-east-1.amazonaws.com/logo.svg" alt="Coachiatry Logo" style="height: 48px; margin-bottom: 8px;" />
        <h2 style="color: #1e88e5; margin: 0;">Password Reset Request</h2>
      </div>

      <p style="font-size: 16px; color: #222;">Hello <strong>${name}</strong>,</p>
      <p style="font-size: 15px; color: #444;">You recently requested to reset your password. Click the button below to set a new one:</p>

      <div style="text-align: center; margin: 28px 0;">
        <a href="${link}"
           style="background: #1e88e5; color: #fff; font-size: 16px; font-weight: 600;
                  padding: 14px 28px; border-radius: 8px; text-decoration: none;
                  display: inline-block; letter-spacing: 0.5px;">
          Reset Password
        </a>
      </div>

      <p style="font-size: 14px; color: #444;">This link is valid for <strong>3 hours</strong> only. After that, you'll need to request a new password reset.</p>
      <p style="font-size: 14px; color: #666;">If you did not request this password reset, please ignore this email. Your account will remain secure.</p>

      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">

      <p style="font-size: 14px; color: #888; text-align: right; margin: 0;">
        Best regards,<br/>
        <span style="color: #1e88e5; font-weight: 600;">Coachiatry Team</span>
      </p>
    </div>
  </div>
  `;
};

export const OTP_EMAIL_HTML = (name: string, otp: string) => {
    return `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f7f7f9; padding: 32px;">
    <div style="max-width: 480px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px;">

      <div style="text-align: center; margin-bottom: 24px;">
        <img
          src="https://coachiatry.s3.us-east-1.amazonaws.com/logo.svg"
          alt="Coachiatry Logo"
          style="height: 48px; margin-bottom: 8px;"
        />
        <h2 style="color: #1e88e5; margin: 0;">Verify Your Account</h2>
      </div>

      <p style="font-size: 16px; color: #222;">
        Hello <strong>${name}</strong>,
      </p>

      <p style="font-size: 15px; color: #444;">
        Use the following One-Time Password (OTP) to complete your verification:
      </p>

      <!-- OTP BOX -->
      <div style="
        margin: 32px 0;
        text-align: center;
      ">
        <div style="
          display: inline-block;
          background: #f1f6ff;
          border: 2px dashed #1e88e5;
          border-radius: 12px;
          padding: 18px 28px;
          font-size: 36px;
          font-weight: 700;
          letter-spacing: 8px;
          color: #1e88e5;
          font-family: 'Courier New', monospace;
        ">
          ${otp}
        </div>
      </div>

      <p style="font-size: 14px; color: #444;">
        This OTP is valid for <strong>5 minutes</strong>. Please do not share it with anyone.
      </p>

      <p style="font-size: 14px; color: #666;">
        If you did not request this verification, please ignore this email.
      </p>

      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">

      <p style="font-size: 14px; color: #888; text-align: right; margin: 0;">
        Best regards,<br/>
        <span style="color: #1e88e5; font-weight: 600;">Coachiatry Team</span>
      </p>
    </div>
  </div>
  `;
};

export const WELCOME_EMAIL_HTML = (name: string) => {
    return `
   <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f7f7f9; padding: 32px;">
      <div style="max-width: 480px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px;">
         <div style="text-align: center; margin-bottom: 24px;">
            <img src="https://coachiatry.s3.us-east-1.amazonaws.com/logo.svg" alt="Coachiatry Logo" style="height: 48px; margin-bottom: 8px;" />
            <h2 style="color: #1e88e5; margin: 0;">Welcome to Coachiatry!</h2>
         </div>
         <p style="font-size: 16px; color: #222;">Dear <strong>${name}</strong>,</p>
         <p style="font-size: 15px; color: #444; margin-bottom:20px">Welcome to Coachiatry! Your account has been successfully created.</p>
         <p style="font-size: 15px; color: #444;">You can now access your dashboard and start using our services.</p>
         <div style="text-align: center; margin: 24px 0;">
            <a href="${process.env.CLIENT_URL || "#"}" style="background: #1e88e5; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">Access Dashboard</a>
         </div>
         <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
         <p style="font-size: 14px; color: #888; text-align: right; margin: 0;">
            Best regards,<br/>
            <span style="color: #1e88e5; font-weight: 600;">Coachiatry Team</span>
         </p>
      </div>
   </div>
   `;
};

export const WELCOME_EMAIL_HTML_WITH_PASSWORD = (
    name: string,
    password: string
) => {
    return `
   <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f7f7f9; padding: 32px;">
      <div style="max-width: 480px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px;">
         <div style="text-align: center; margin-bottom: 24px;">
            <img src="https://coachiatry.s3.us-east-1.amazonaws.com/logo.svg" alt="Coachiatry Logo" style="height: 48px; margin-bottom: 8px;" />
            <h2 style="color: #1e88e5; margin: 0;">Welcome to Coachiatry!</h2>
         </div>
         <p style="font-size: 16px; color: #222;">Dear <strong>${name}</strong>,</p>
         <p style="font-size: 15px; color: #444; margin-bottom:20px">Welcome to Coachiatry! Your account has been successfully created.</p>
         <p style="font-size: 15px; color: #444;">You can now access your dashboard and start using our services.</p>
         <p style="font-size: 15px; color: #444;">Temporary password</p>
         <div style="
        margin: 32px 0;
        text-align: center;
      ">
        <div style="
          display: inline-block;
          background: #f1f6ff;
          border: 2px dashed #1e88e5;
          border-radius: 12px;
          padding: 18px 28px;
          font-size: 28px;
          font-weight: 700;
          letter-spacing: 8px;
          color: #1e88e5;
          font-family: 'Courier New', monospace;
        ">
          ${password}
        </div>
      </div>
         <div style="text-align: center; margin: 24px 0;">
            <a href="${process.env.CLIENT_URL || "#"}" style="background: #1e88e5; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">Access Dashboard</a>
         </div>
         <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
         <p style="font-size: 14px; color: #888; text-align: right; margin: 0;">
            Best regards,<br/>
            <span style="color: #1e88e5; font-weight: 600;">Coachiatry Team</span>
         </p>
      </div>
   </div>
   `;
};

export const GROUP_INVITE_HTML = (
    inviterName: string,
    groupName: string,
    link: string,
    isNewUser: boolean
) => {
    const cta = isNewUser ? "Sign up & join" : "Join the group";
    const helper = isNewUser
        ? "You'll be asked to create an account, then you'll join the group automatically."
        : "Log in to join the group automatically.";
    return `
   <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f7f7f9; padding: 32px;">
      <div style="max-width: 480px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px;">
         <div style="text-align: center; margin-bottom: 24px;">
            <img src="https://coachiatry.s3.us-east-1.amazonaws.com/logo.svg" alt="Coachiatry Logo" style="height: 48px; margin-bottom: 8px;" />
            <h2 style="color: #1e88e5; margin: 0;">You're invited to a group</h2>
         </div>
         <p style="font-size: 16px; color: #222;">Hi there,</p>
         <p style="font-size: 15px; color: #444; line-height: 1.6;">
            <strong>${inviterName}</strong> has invited you to join the group
            <strong>"${groupName}"</strong> on <strong>Coachiatry</strong>.
         </p>
         <div style="text-align: center; margin: 32px 0;">
            <a href="${link}" style="background: #1e88e5; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; display: inline-block;">${cta}</a>
         </div>
         <p style="font-size: 13px; color: #888; line-height: 1.6;">${helper}</p>
         <p style="font-size: 13px; color: #888; line-height: 1.6;">
            If the button doesn't work, copy and paste this link into your browser:<br/>
            <a href="${link}" style="color: #1e88e5; word-break: break-all;">${link}</a>
         </p>
         <p style="font-size: 13px; color: #aaa; margin-top: 24px;">
            If you weren't expecting this invitation, you can safely ignore this email.
         </p>
         <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
         <p style="font-size: 14px; color: #888; text-align: right; margin: 0;">
            Best regards,<br/>
            <span style="color: #1e88e5; font-weight: 600;">Coachiatry Team</span>
         </p>
      </div>
   </div>
   `;
};

export const WATCHER_INVITE_HTML = (inviterName: string, link: string) => {
    return `
   <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f7f7f9; padding: 32px;">
      <div style="max-width: 480px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px;">
         <div style="text-align: center; margin-bottom: 24px;">
            <img src="https://coachiatry.s3.us-east-1.amazonaws.com/logo.svg" alt="Coachiatry Logo" style="height: 48px; margin-bottom: 8px;" />
            <h2 style="color: #1e88e5; margin: 0;">You've been invited!</h2>
         </div>
         <p style="font-size: 16px; color: #222;">Hi there,</p>
         <p style="font-size: 15px; color: #444; line-height: 1.6;">
            <strong>${inviterName}</strong> has invited you to follow their tasks and progress on
            <strong>Coachiatry</strong> as a watcher. Click the button below to accept the invitation.
         </p>
         <div style="text-align: center; margin: 32px 0;">
            <a href="${link}" style="background: #1e88e5; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; display: inline-block;">Accept Invitation</a>
         </div>
         <p style="font-size: 13px; color: #888; line-height: 1.6;">
            If the button doesn't work, copy and paste this link into your browser:<br/>
            <a href="${link}" style="color: #1e88e5; word-break: break-all;">${link}</a>
         </p>
         <p style="font-size: 13px; color: #aaa; margin-top: 24px;">
            If you weren't expecting this invitation, you can safely ignore this email.
         </p>
         <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
         <p style="font-size: 14px; color: #888; text-align: right; margin: 0;">
            Best regards,<br/>
            <span style="color: #1e88e5; font-weight: 600;">Coachiatry Team</span>
         </p>
      </div>
   </div>
   `;
};

export const ACCOUNT_CREATED_HTML = (
    name: string,
    email: string,
    tempPassword?: string
) => {
    return `
   <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f7f7f9; padding: 32px;">
      <div style="max-width: 480px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px;">
         <div style="text-align: center; margin-bottom: 24px;">
            <img src="https://coachiatry.s3.us-east-1.amazonaws.com/logo.svg" alt="Coachiatry Logo" style="height: 48px; margin-bottom: 8px;" />
            <h2 style="color: #1e88e5; margin: 0;">Account Created Successfully</h2>
         </div>
         <p style="font-size: 16px; color: #222;">Hello <strong>${name}</strong>,</p>
         <p style="font-size: 15px; color: #444;">Your account has been successfully created! Here are your account details:</p>
         <table style="width: 100%; font-size: 15px; color: #444; margin: 16px 0; background: #f8f9fa; padding: 16px; border-radius: 8px;">
            <tr>
               <td style="font-weight: bold; padding: 6px 0;">Email:</td>
               <td>${email}</td>
            </tr>
            ${
                tempPassword
                    ? `<tr>
               <td style="font-weight: bold; padding: 6px 0;">Temporary Password:</td>
               <td style="font-family: monospace; background: #e3f2fd; padding: 4px 8px; border-radius: 4px;">${tempPassword}</td>
            </tr>`
                    : ""
            }
         </table>
         ${tempPassword ? '<p style="font-size: 14px; color: #d32f2f; font-weight: bold;">Please change your password after first login.</p>' : ""}
         <div style="text-align: center; margin: 24px 0;">
            <a href="${process.env.CLIENT_URL || "#"}" style="background: #1e88e5; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">Login to Your Account</a>
         </div>
         <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
         <p style="font-size: 14px; color: #888; text-align: right; margin: 0;">
            Best regards,<br/>
            <span style="color: #1e88e5; font-weight: 600;">Coachiatry Team</span>
         </p>
      </div>
   </div>
   `;
};

export const subCriptionExpireAlertHTML = (
    name: string,
    subscriptionEndDate: string
) => {
    return `
   <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f7f7f9; padding: 32px;">
      <div style="max-width: 480px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px;">
         <div style="text-align: center; margin-bottom: 24px;">
            <img src="https://i.imgur.com/1Q9Z1Zl.png" alt="Health Care Logo" style="height: 48px; margin-bottom: 8px;" />
            <h2 style="color: #d32f2f; margin: 0;">Subscription Expiration Alert</h2>
         </div>
         <p style="font-size: 16px; color: #222;">Dear <strong>${name}</strong>,</p>
         <p style="font-size: 15px; color: #444;">This is a reminder that your subscription will expire on:</p>
         <div style="background: #ffebee; color: #c62828; font-size: 18px; font-weight: bold; padding: 12px 0; border-radius: 6px; text-align: center; margin: 16px 0;">
            ${subscriptionEndDate}
         </div>
         <p style="font-size: 14px; color: #555;">Please renew your subscription to continue enjoying our services without interruption.</p>
         <div style="text-align: center; margin: 24px 0;">
            <a href="${process.env.CLIENT_URL || "#"}" style="background: #d32f2f; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">Renew Subscription</a>
         </div>
         <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
         <p style="font-size: 14px; color: #888; text-align: right; margin: 0;">
            Best regards,<br/>
            <span style="color: #d32f2f; font-weight: 600;">Health Care Team</span>
         </p>
      </div>
   </div>
   `;
};
