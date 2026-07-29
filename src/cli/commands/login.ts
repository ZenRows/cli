/**
 * `zenrows login` — configure credentials.
 *   --api-key <key>   store the key in .zenrows/secrets.json (0600, gitignored)
 *   --env             confirm ZENROWS_API_KEY from the environment
 *   --browser         open the dashboard to create/copy an API key
 */
import { authState, ENV_KEY, saveApiKey } from "../../core/auth.ts";
import { log } from "../../core/logger.ts";
import { mask } from "../../core/redact.ts";
import { openUrl, SIGNUP_URL, DASHBOARD_URL } from "../../core/open-url.ts";
import { ToolkitError } from "../../core/errors.ts";
import { parse, asString, type Command, type RunContext } from "../command.ts";

export const login: Command = {
  name: "login",
  summary: "Configure your Zenrows API key (never printed or committed).",
  usage: "zenrows login [--api-key <key> | --env | --browser]",
  help: "Modes:\n  --api-key <key>   store key locally (recommended)\n  --env             use ZENROWS_API_KEY from the environment\n  --browser         open the Zenrows dashboard to get a key",
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const { values } = parse(argv, {
      "api-key": { type: "string" },
      env: { type: "boolean" },
      browser: { type: "boolean" },
    });

    if (values.browser) {
      log.step("Opening the Zenrows dashboard to create/copy your API key…");
      await openUrl(DASHBOARD_URL);
      log.info(`Then run:  zenrows login --api-key <your-key>`);
      log.dim(`Sign up:   ${SIGNUP_URL}`);
      return 0;
    }

    const key = asString(values["api-key"]);
    if (key) {
      saveApiKey(key);
      log.success(`Stored API key (${mask(key)}) in .zenrows/secrets.json.`);
      log.dim("Validate connectivity with: zenrows status");
      if (ctx.json) log.out(JSON.stringify({ ok: true, source: "secrets-file", masked: mask(key) }, null, 2));
      return 0;
    }

    if (values.env) {
      const st = authState();
      if (st.source === "env" && st.hasKey) {
        log.success(`Using ${ENV_KEY} from the environment (${st.masked}).`);
        return 0;
      }
      throw new ToolkitError({
        code: "AUTH_MISSING",
        message: `${ENV_KEY} is not set in the environment.`,
        likely_cause: "The environment variable is empty or unset.",
        next_action: `export ${ENV_KEY}=<your-key>  (or use --api-key).`,
      });
    }

    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Choose a login mode.",
      likely_cause: "No mode flag was provided.",
      next_action: "Use --api-key <key>, --env, or --browser.",
      suggested_commands: ["zenrows login --api-key <your-key>", "zenrows login --browser"],
    });
  },
};
