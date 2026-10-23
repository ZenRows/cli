/**
 * `zenrows signup` — help a new user obtain credentials.
 *
 * There is no documented programmatic signup API, so we never fake account
 * creation: we explain what is needed, open the signup URL, and hand off to
 * `login`.
 *
 * `--agent` provisions a Free plan account headless, and `--answer` answers the
 * one short question signup may ask an agent first (SIGNUP_CHALLENGE).
 */
import { answerSignupChallenge, readAccount, signupAgent } from "../../core/agent-account.ts";
import { storeSignup } from "../../core/ensure-key.ts";
import { ToolkitError } from "../../core/errors.ts";
import { attributionEnabled } from "../../core/config.ts";
import { log } from "../../core/logger.ts";
import { openUrl, SIGNUP_URL, withParams } from "../../core/open-url.ts";
import { attributionParams } from "../../core/provenance.ts";
import { parse, type Command, type RunContext } from "../command.ts";

export const signup: Command = {
  name: "signup",
  summary: "Create a Zenrows account / obtain an API key (opens the browser).",
  usage: 'zenrows signup [--agent] [--no-open] [--answer "<text>"]',
  help: [
    "Without flags, opens the Zenrows signup page in the browser.",
    "",
    "  --agent           Create a Free plan account headless and store its key.",
    "  --no-open         Print the signup URL instead of opening it.",
    '  --answer "<text>" Answer the question Zenrows asked before creating an account',
    "                    (error SIGNUP_CHALLENGE). Answer it yourself, then re-run",
    "                    your original command.",
  ].join("\n"),
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const { values } = parse(argv, {
      "no-open": { type: "boolean" },
      agent: { type: "boolean" },
      answer: { type: "string" },
    });

    if (values.answer !== undefined) {
      const answer = String(values.answer).trim();
      if (!answer) {
        throw new ToolkitError({
          code: "INVALID_USAGE",
          message: "--answer needs the answer text.",
          likely_cause: "An empty value was passed to --answer.",
          next_action: 'Run: zenrows signup --answer "<your answer>"',
        });
      }
      const res = await answerSignupChallenge(answer);
      const account = storeSignup(res);
      log.success("Right answer. Created a Zenrows Free plan account and stored its API key.");
      log.dim(`Claim it anytime (keeps your usage): ${account.claimUrl}`);
      log.info("Now re-run your original command.");
      if (ctx.json) {
        log.out(
          JSON.stringify(
            { ok: true, accountId: res.accountId, claimUrl: res.claimUrl, next_action: "Re-run your original command." },
            null,
            2,
          ),
        );
      }
      return 0;
    }

    if (values.agent) {
      const account = readAccount();
      if (account) { log.info("An agent account already exists. Claim it with: zenrows account claim"); return 0; }
      const res = await signupAgent();
      storeSignup(res);
      log.success("Created a Zenrows Free plan account.");
      log.dim(`Claim it anytime: ${res.claimUrl}`);
      if (ctx.json) log.out(JSON.stringify({ ok: true, accountId: res.accountId, claimUrl: res.claimUrl }, null, 2));
      return 0;
    }

    log.info("To use the toolkit you need a Zenrows account and an API key.");
    log.info("1. Create a free account.");
    log.info("2. Copy your API key from the dashboard.");
    log.info("3. Run: zenrows login --api-key <your-key>");
    log.info("");
    // Attach anonymous utm attribution so the web app can attribute this signup
    // to the agent context (no separate request — it rides the URL we open).
    const signupUrl = attributionEnabled() ? withParams(SIGNUP_URL, attributionParams()) : SIGNUP_URL;
    if (!values["no-open"]) {
      log.step(`Opening ${signupUrl} …`);
      await openUrl(signupUrl);
    } else {
      log.info(`Sign up at: ${signupUrl}`);
    }
    if (ctx.json) log.out(JSON.stringify({ ok: true, signupUrl, fakeAccountCreation: false }, null, 2));
    return 0;
  },
};
