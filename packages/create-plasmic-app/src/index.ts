#!/usr/bin/env node
import * as Sentry from "@sentry/node";
import chalk from "chalk";
import * as fs from "fs";
import inquirer, { DistinctQuestion } from "inquirer";
import * as path from "upath";
import validateProjectName from "validate-npm-package-name";
import yargs from "yargs";
import * as cpa from "./lib";
import { assert, ensure, ensureString } from "./utils/lang-utils";
import { updateNotify } from "./utils/npm-utils";

if (process.env.CPA_DEBUG_CHDIR) {
  process.chdir(process.env.CPA_DEBUG_CHDIR);
}

// Check for updates
const createPlasmicAppVersion = updateNotify();

// Specify command-line args
const argv = yargs
  .usage("Usage: $0 [options] <project-directory>")
  .example([
    ["$0 my-plasmic-app", "--- Create the project in `my-plasmic-app/`"],
  ])
  .option("platform", {
    describe: "Target platform",
    choices: ["", "nextjs", "gatsby", "react"],
    default: "",
  })
  .option("scheme", {
    describe: "Plasmic integration scheme",
    choices: ["", "codegen", "loader"],
    default: "",
  })
  .option("projectId", {
    describe: "Plasmic project ID",
    string: true,
    default: "",
  })
  .option("projectApiToken", {
    describe: "Plasmic project API token (optional, to bypass standard auth)",
    string: true,
    default: "",
  })
  .option("template", {
    describe: "Specify a template for the created project",
    string: true,
    default: "",
  })
  .option("typescript", {
    describe: "Use the default Typescript template",
    boolean: true,
    default: "",
  })
  .strict()
  .help("h")
  .alias("h", "help").argv;

// Initialize Sentry
Sentry.init({
  dsn:
    "https://0d602108de7f44aa9470a41cc069395f@o328029.ingest.sentry.io/5679926",
});
Sentry.configureScope((scope) => {
  //scope.setUser({ email: auth.user });
  scope.setExtra("cliVersion", createPlasmicAppVersion);
  scope.setExtra("args", JSON.stringify(argv));
});

/**
 * Prompt the user for any answers that we're missing from the command-line args
 * @param question instance of a question formatted for `inquirer`
 * @returns
 */
async function maybePrompt(question: DistinctQuestion) {
  const name = ensure(question.name) as string;
  const message = ensure(question.message);
  const maybeAnswer = argv[name];
  if (maybeAnswer === null || maybeAnswer === undefined || maybeAnswer === "") {
    const ans = await inquirer.prompt({ ...question });
    return ans[name];
  } else {
    console.log(`${message}: ${maybeAnswer} (specified in CLI arg)`);
    return ensure(argv[name]);
  }
}

// Keeping these as globals to easily share with our `crash` function
let projectPath: string;
let resolvedProjectPath: string;

/**
 * Main function
 */
async function run(): Promise<void> {
  /**
   * PROMPT USER
   */
  // User-specified project path/directory
  projectPath = (argv._.length > 0
    ? argv._[0] + "" // coerce to a string
    : (
        await inquirer.prompt({
          name: "projectPath",
          message: "What is your project named?",
          default: "my-app",
        })
      ).projectPath
  ).trim();
  // Absolute path to the new project
  resolvedProjectPath = path.resolve(projectPath);
  // Reuse the basename as the project name
  const projectName = path.basename(resolvedProjectPath);

  // User need to specify a truthy value
  if (!projectPath) {
    throw new Error("Please specify the project directory");
  }

  // Check that projectName is a valid npm package name
  const nameValidation = validateProjectName(projectName);
  if (!nameValidation.validForNewPackages) {
    if (nameValidation.warnings) {
      nameValidation.warnings.forEach((e) => console.warn(e));
    }
    if (nameValidation.errors) {
      nameValidation.errors.forEach((e) => console.error(e));
    }
    throw new Error(
      `${projectName} is not a valid name for an npm package. Please choose another name.`
    );
  }

  // Prompt for Typescript
  const useTypescript: boolean = await maybePrompt({
    name: "typescript",
    message: "What language do you want to use?",
    type: "list",
    choices: () => [
      {
        name: "JavaScript",
        value: false,
      },
      {
        name: "TypeScript",
        value: true,
      },
    ],
    default: false,
  });

  // Prompt for the platform
  const platform = ensureString(
    await maybePrompt({
      name: "platform",
      message: "What React framework do you want to use?",
      type: "list",
      choices: () => [
        {
          name: "Next.js",
          value: "nextjs",
        },
        {
          name: "Gatsby",
          value: "gatsby",
        },
        {
          name: "Create React App",
          value: "react",
        },
      ],
      default: "nextjs",
    })
  );

  // Scheme to use for Plasmic integration
  // - loader only available for gatsby/next.js
  const scheme: "codegen" | "loader" =
    platform === "nextjs" || platform === "gatsby"
      ? await maybePrompt({
          name: "scheme",
          message: "Which scheme do you want to use to integrate Plasmic?",
          type: "list",
          choices: () => [
            {
              name: "PlasmicLoader: recommended default for most websites",
              short: "PlasmicLoader",
              value: "loader",
            },
            {
              name: "Codegen: for building complex stateful apps",
              short: "Codegen",
              value: "codegen",
            },
          ],
          default: "loader",
        })
      : "codegen";

  // Get the projectId
  console.log();
  console.log(chalk.green.bold("Go to this URL and **clone** the project:"));
  console.log("https://studio.plasmic.app/starters/simple-light");
  console.log();
  console.log("  Note the project ID in the URL redirect");
  console.log("  (e.g. https://studio.plasmic.app/projects/PROJECT_ID)");
  let projectId: string | undefined;
  while (!projectId) {
    const rawProjectId = await maybePrompt({
      name: "projectId",
      message: "What is the project ID of your project?",
    });
    projectId = rawProjectId
      .replace("https://studio.plasmic.app/projects/", "")
      .trim();
    if (!projectId) {
      console.error(`"${rawProjectId}" is not a valid project ID.`);
    }
  }

  const template = argv["template"];
  const projectApiToken = argv["projectApiToken"];

  // RUN IT
  console.log();
  assert(
    platform === "nextjs" || platform === "gatsby" || platform === "react",
    "platform must be one of ['nextjs', 'gatsby', 'react']"
  );
  await cpa.create({
    resolvedProjectPath,
    projectId,
    platform,
    scheme,
    useTypescript,
    projectApiToken,
    template,
  });
}

run().catch((err) => {
  console.log();
  console.log("Aborting installation.");
  cpa.banner("create-plasmic-app failed!");

  console.error("Unexpected error: ");
  console.error(err);
  console.log();

  // Instruct user to remove artifacts
  if (fs.existsSync(resolvedProjectPath)) {
    console.log(`Please remove ${resolvedProjectPath} and try again.`);
  }

  // Log to Sentry
  if (err) {
    Sentry.captureException(err);
  }

  process.exit(1);
});
