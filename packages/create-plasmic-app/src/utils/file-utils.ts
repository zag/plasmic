import { createReadStream, unlinkSync } from "fs";
import * as fs from "fs/promises";
import glob from "glob";
import L from "lodash";
import * as readline from "readline";
import * as path from "upath";
import { ensure, ensureString } from "./lang-utils";

/**
 * Runs the search pattern through `glob` and deletes all resulting files
 * @param searchPattern - glob search query
 * @param skipPatterns - array of fragments. Skip any file contains any of the fragments
 */
export function deleteGlob(
  searchPattern: string,
  skipPatterns?: string[]
): void {
  const filesToDelete = glob
    .sync(searchPattern)
    .filter(
      (file) =>
        !skipPatterns || !skipPatterns.find((pattern) => file.includes(pattern))
    );
  filesToDelete.forEach((f: string) => unlinkSync(f));
}

export function stripExtension(
  filename: string,
  removeComposedPath = false
): string {
  const ext = removeComposedPath
    ? filename.substring(filename.indexOf("."))
    : path.extname(filename);
  if (!ext || filename === ext) {
    return filename;
  }
  return filename.substring(0, filename.lastIndexOf(ext));
}

/**
 * create-next-app doesn't create next.config.js,
 * so it's safe to just write the file
 * @param absPath
 * @param projectId
 * @returns
 */
export async function writeDefaultNextjsConfig(
  projectDir: string,
  projectId: string
): Promise<void> {
  const nextjsConfigFile = path.join(projectDir, "next.config.js");
  await fs.writeFile(
    nextjsConfigFile,
    `
const plasmic = require('@plasmicapp/loader/next');
const withPlasmic = plasmic({
  projects: ['${projectId}'] // An array of project ids.
});
module.exports = withPlasmic({
  trailingSlash: true,
  // Your NextJS config.
});
  `
  );
}

export async function writePlasmicLoaderJson(
  projectDir: string,
  projectId: string,
  projectApiToken: string
): Promise<void> {
  const plasmicLoaderJson = path.join(projectDir, "plasmic-loader.json");
  const content = {
    projects: [
      {
        projectId,
        projectApiToken,
      },
    ],
  };
  await fs.writeFile(plasmicLoaderJson, JSON.stringify(content));
}

/**
 * create-gatsby will create a default gatsby-config.js that we need to modify
 * @param absPath
 * @param projectId
 * @returns
 */
export async function modifyDefaultGatsbyConfig(
  projectDir: string,
  projectId: string
): Promise<void> {
  const gatsbyConfigFile = path.join(projectDir, "gatsby-config.js");
  const rl = readline.createInterface({
    input: createReadStream(gatsbyConfigFile),
    crlfDelay: Infinity,
  });
  let result = "";
  for await (const line of rl) {
    result += line + "\n";
    // Prepend PlasmicLoader to list of plugins
    if (line.includes("plugins:")) {
      result +=
        `
    {
      resolve: "@plasmicapp/loader/gatsby",
      options: {
        projects: ["${projectId}"], // An array of project ids.
      },
    },` + "\n";
    }
  }
  await fs.writeFile(gatsbyConfigFile, result);
}

/**
 * - [nextjs|gatsby, loader, '/' page exists] - remove index file
 * - [nextjs|gatsby, loader, '/' Page DNE] - replace index file with Welcome page
 * - [nextjs|gatsby, codegen, '/' page exists] - remove Next.js/Gatsby index file, preserve Plasmic index
 * - [nextjs|gatsby, codegen, '/' page DNE] - replace index file with Welcome page
 * - [react, codegen ]  - replace App file with '/', Home, or Welcome page
 * @returns
 */
export async function overwriteIndex(
  projectPath: string,
  platform: string,
  scheme: string
): Promise<void> {
  const isNextjs = platform === "nextjs";
  const isGatsby = platform === "gatsby";
  const isCra = platform === "react";
  const isLoader = scheme === "loader";
  const isCodegen = scheme === "codegen";

  const configPath = ensure(
    isCodegen
      ? "plasmic.json"
      : isNextjs && isLoader
      ? ".plasmic/plasmic.json"
      : isGatsby && isLoader
      ? ".cache/.plasmic/plasmic.json"
      : undefined
  );
  const configStr = await fs.readFile(path.join(projectPath, configPath));
  const config = JSON.parse(configStr.toString());
  const plasmicFiles = L.map(
    L.flatMap(config.projects, (p) => p.components),
    (c) => c.importSpec.modulePath
  );

  const isTypescript = config?.code?.lang === "ts";
  const pagesDir = ensure(
    isNextjs
      ? path.join(projectPath, "pages/")
      : isGatsby
      ? path.join(projectPath, "src/pages/")
      : isCra
      ? path.join(projectPath, "src/")
      : undefined
  );
  const indexBasename = isCra ? `App` : `index`;
  const extension = isTypescript ? "tsx" : "jsx";
  const indexAbsPath = path.join(pagesDir, `${indexBasename}.${extension}`);

  // Delete existing index files
  // - Skipping any Plasmic-managed files
  // - Note: this only compares basenames, so it may have false positives
  deleteGlob(
    path.join(pagesDir, `${indexBasename}.*`),
    plasmicFiles.map((f) => path.basename(f))
  );

  // Special case: remove all Gatsby components (due to conflicting file names)
  // TODO: find a better way to handle this issue
  if (platform === "gatsby") {
    // Delete the index file
    deleteGlob(
      path.join(projectPath, "src/@(pages|components)/*.*"),
      plasmicFiles.map((f) => path.basename(f))
    );
  }

  // We're done if we can already render an index page
  if (
    (isNextjs || isGatsby) &&
    plasmicFiles.find((f) => f.includes("/index."))
  ) {
    return;
  }

  const homeFilePossibilities = glob.sync(
    path.join(
      projectPath,
      ensureString(config.srcDir),
      "**",
      "@(index|Home|home).*"
    )
  );
  const content =
    isCra && homeFilePossibilities.length > 0
      ? generateHomePage(homeFilePossibilities[0], indexAbsPath)
      : generateWelcomePage(config, isCra);
  await fs.writeFile(indexAbsPath, content);
}

/**
 * Generate a file to render the component
 * @param componentAbsPath - absolute path to component to render
 * @param indexAbsPath - absolute path of index file to write
 * @returns
 */
function generateHomePage(
  componentAbsPath: string,
  indexAbsPath: string
): string {
  const componentFilename = path.basename(componentAbsPath);
  const componentName = stripExtension(componentFilename);
  // The relative import path from App.js to the Plasmic component
  const componentRelativePath = path.relative(
    path.dirname(indexAbsPath),
    componentAbsPath
  );
  const appjsContents = `
import ${componentName} from './${stripExtension(componentRelativePath)}';

function App() {
  return (<${componentName} />);
}

export default App;
  `;
  return appjsContents;
}

/**
 * Generate a Welcome page based on a PlasmicConfig
 * @param config - PlasmicConfig
 * @param noPages - don't render links to pages
 * @returns
 */
function generateWelcomePage(config: any, noPages?: boolean): string {
  const getPageSection = () => {
    if (noPages || !config || !L.isArray(config.projects)) {
      return "";
    }

    const pageComponents = L.flatMap(
      config.projects,
      (p) => p.components
    ).filter((c) => c.componentType === "page");
    const pagesDir =
      config?.nextjsConfig?.pagesDir ?? config?.gatsbyConfig?.pagesDir;

    if (pageComponents.length <= 0 || !pagesDir) {
      return "";
    }

    const pageLinks = pageComponents
      .map((pc) => {
        // Get the relative path on the filesystem
        const relativePath = path.relative(pagesDir, pc.importSpec.modulePath);
        // Format as an absolute path without the extension name
        const relativeLink = "/" + stripExtension(relativePath);
        return `<li><a style={{ color: "blue" }} href="${relativeLink}">${pc.name} - ${relativeLink}</a></li>`;
      })
      .join("\n");
    return `
          <h3>Your pages:</h3>
          <ul>
            ${pageLinks}
          </ul>
    `;
  };

  const content = `
import React from "react";
function Index() {
  return (
    <div style={{ width: "100%", padding: "100px", alignContent: "center" }}>
      <header>
        <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0zNCAyNkgzMlYyNUMzMiAxOC4zNzI5IDI2LjYyNzEgMTMuMDAwNiAyMCAxMy4wMDA2QzEzLjM3MjkgMTMuMDAwNiA4LjAwMDU1IDE4LjM3MjkgOC4wMDA1NSAyNUw4IDI2SDZDNS40NDc3MSAyNiA1IDI1LjU1MjMgNSAyNUM1IDE2LjcxNTkgMTEuNzE2IDEwLjAwMDQgMjAgMTAuMDAwNEMyOC4yODQxIDEwLjAwMDQgMzQuOTk5NiAxNi43MTU5IDM0Ljk5OTYgMjVDMzQuOTk5NiAyNS41NTIzIDM0LjU1MjMgMjYgMzQgMjZaIiBmaWxsPSJ1cmwoI3BhaW50MF9saW5lYXIpIi8+CjxwYXRoIGQ9Ik0yNi45OTkxIDI1QzI2Ljk5OTEgMjEuMTM0NiAyMy44NjU1IDE4LjAwMSAyMCAxOC4wMDFDMTYuMTM0NSAxOC4wMDExIDEzIDIxLjEzNDYgMTMgMjVWMjZIMTVDMTUuNTUyMyAyNiAxNiAyNS41NTIzIDE2IDI1QzE2IDIyLjc5MDkgMTcuNzkwOSAyMSAyMCAyMUMyMi4yMDkxIDIxIDI0IDIyLjc5MDkgMjQgMjVDMjQgMjUuNTUyMyAyNC40NDc3IDI2IDI1IDI2SDI3TDI2Ljk5OTEgMjVaIiBmaWxsPSJ1cmwoI3BhaW50MV9saW5lYXIpIi8+CjxwYXRoIGQ9Ik0zMC45OTkgMjQuOTk5OUMzMC45OTkgMTguOTI1NCAyNi4wNzQ2IDE0LjAwMSAyMCAxNC4wMDFDMTMuOTI1NCAxNC4wMDEgOS4wMDEwNSAxOC45MjU1IDkuMDAxMDUgMjVIOVYyNkgxMi4wMDA0VjI1QzEyLjAwMDQgMjAuNTgyIDE1LjU4MiAxNy4wMDA1IDIwIDE3LjAwMDVDMjQuNDE4IDE3LjAwMDUgMjggMjAuNTgyIDI4IDI1VjI2SDMxVjI1TDMwLjk5OSAyNC45OTk5WiIgZmlsbD0idXJsKCNwYWludDJfbGluZWFyKSIvPgo8ZGVmcz4KPGxpbmVhckdyYWRpZW50IGlkPSJwYWludDBfbGluZWFyIiB4MT0iNSIgeTE9IjI2IiB4Mj0iMzUiIHkyPSIyNiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjMTg3N0YyIi8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzA0QTRGNCIvPgo8L2xpbmVhckdyYWRpZW50Pgo8bGluZWFyR3JhZGllbnQgaWQ9InBhaW50MV9saW5lYXIiIHgxPSIxMyIgeTE9IjI2IiB4Mj0iMjciIHkyPSIyNiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjRjAyODQ5Ii8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI0Y1NTMzRCIvPgo8L2xpbmVhckdyYWRpZW50Pgo8bGluZWFyR3JhZGllbnQgaWQ9InBhaW50Ml9saW5lYXIiIHgxPSI5IiB5MT0iMjYiIHgyPSIzMSIgeTI9IjI2IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CjxzdG9wIHN0b3AtY29sb3I9IiM0NUJENjIiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMkFCQkE3Ii8+CjwvbGluZWFyR3JhZGllbnQ+CjwvZGVmcz4KPC9zdmc+Cg==" alt="" />
        <h1 style={{ margin: 0 }}>
          Welcome to Plasmic!
        </h1>
        <h4>
          <a
            style={{ color: "blue" }}
            href="https://www.plasmic.app/learn/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Learn Plasmic
          </a>
        </h4>
        ${getPageSection()}
        <p><i>Note: Remember to remove this file if you introduce a Page component at the '/' path.</i></p>
      </header>
    </div>
  );
}

export default Index;
  `;
  return content;
}
