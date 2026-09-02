import { copy } from "../copy.it";

export interface CustomerEmailApproval {
  attachment: string;
  body: string;
  mode: "AUTOMATIC" | "DISABLED" | "MANUAL";
  recipient: string | null;
  sender: string;
  subject: string;
}

export function CustomerEmailApprovalFields({
  choiceName,
  email,
  required,
}: {
  choiceName: string;
  email: CustomerEmailApproval;
  required?: boolean;
}) {
  return (
    <>
      <dl className="facts facts--columns">
        <div>
          <dt>{copy.document.emailMode}</dt>
          <dd>
            {email.mode === "AUTOMATIC"
              ? copy.document.emailAutomatic
              : email.mode === "DISABLED"
                ? copy.document.emailDisabled
                : copy.document.emailManual}
          </dd>
        </div>
        <div>
          <dt>{copy.document.emailSender}</dt>
          <dd>{email.sender}</dd>
        </div>
        <div>
          <dt>{copy.document.emailRecipient}</dt>
          <dd>{email.recipient ?? copy.common.unavailable}</dd>
        </div>
        <div>
          <dt>{copy.document.emailSubject}</dt>
          <dd>{email.subject}</dd>
        </div>
        <div>
          <dt>{copy.document.emailBody}</dt>
          <dd>{email.body}</dd>
        </div>
        <div>
          <dt>{copy.document.emailAttachment}</dt>
          <dd>{email.attachment}</dd>
        </div>
      </dl>
      {email.mode === "DISABLED" ? (
        <>
          <input name={choiceName} type="hidden" value="SKIP" />
          <p className="notice">{copy.document.emailDisabledHelp}</p>
        </>
      ) : (
        <>
          <label className="checkbox-row">
            <input
              defaultChecked={email.mode === "AUTOMATIC" && Boolean(email.recipient)}
              name={choiceName}
              required={required}
              type="radio"
              value="SEND"
            />
            {copy.document.emailSend}
          </label>
          <label className="checkbox-row">
            <input
              defaultChecked={email.mode !== "AUTOMATIC" || !email.recipient}
              name={choiceName}
              required={required}
              type="radio"
              value="SKIP"
            />
            {copy.document.emailSkip}
          </label>
        </>
      )}
    </>
  );
}
