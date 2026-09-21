
import AdmZip from "adm-zip";
import path from "path";
import crypto from "crypto";

const MAX_FILES = parseInt(process.env.MAX_FILES_PER_REPO || "100");
const MAX_KB = parseInt(process.env.MAX_FILE_SIZE_KB || "50");
const MAX_ZIP_SIZE =
  parseInt(process.env.MAX_ZIP_SIZE_MB || "50") * 1024 * 1024;

const SKIP_EXT =
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|mp4|mp3|bin|exe|dll|so|dylib|lock)$/i;




export function validateZipBuffer(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error("ZIP file is empty");
  }

  if (buffer.length > MAX_ZIP_SIZE) {
    throw new Error(
      `ZIP file exceeds maximum size of ${MAX_ZIP_SIZE / 1024 / 1024}MB`,
    );
  }


  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error("File is not a valid ZIP archive");
  }
}




export function extractZipFiles(buffer, zipFilename = "upload.zip") {
  validateZipBuffer(buffer);

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error(`Failed to parse ZIP: ${err.message}`);
  }

  const entries = zip.getEntries();
  const files = [];
  let totalSize = 0;


  const topLevelDirs = new Set();
  entries.forEach((e) => {
    if (e.isDirectory) return;
    const firstPart = e.entryName.split("/")[0];
    if (firstPart) topLevelDirs.add(firstPart);
  });

  const hasRootFolder = topLevelDirs.size === 1;
  const rootPrefix = hasRootFolder ? `${Array.from(topLevelDirs)[0]}/` : "";

  for (const entry of entries) {

    if (entry.isDirectory) continue;


    let filePath = entry.entryName;
    if (hasRootFolder && filePath.startsWith(rootPrefix)) {
      filePath = filePath.slice(rootPrefix.length);
    }


    if (SKIP_EXT.test(filePath) || entry.header.size > MAX_KB * 1024) {
      continue;
    }


    const filename = path.basename(filePath);
    if (isSecretDotfile(filename)) {
      continue;
    }
    if (filename.startsWith(".") && !isImportantDotfile(filename)) {
      continue;
    }

    try {
      const data = entry.getData();
      const content = data.toString("utf-8");


      if (!content.trim()) continue;

      files.push({ path: filePath, content });
      totalSize += content.length;
    } catch {

      continue;
    }
  }


  files.sort((a, b) => a.path.localeCompare(b.path));


  const truncated = files.slice(0, MAX_FILES);


  const projectName = zipFilename
    .replace(/\.zip$/i, "")
    .replace(/[-_]/g, " ")
    .trim();

  return {
    files: truncated,
    meta: {
      name: projectName,
      fileCount: truncated.length,
      totalSize,
      uploadedAt: new Date(),
      zipFilename,
      checksum: crypto.randomBytes(16).toString("hex"),
    },
  };
}



function isImportantDotfile(filename) {
  const important = [
    ".gitignore",
    ".env.example",
    ".env.sample",
    ".gitattributes",
    ".prettierrc",
    ".eslintrc",
    ".eslintignore",
    ".dockerignore",
  ];
  return important.includes(filename);
}

function isSecretDotfile(filename) {
  if (filename === ".env.example" || filename === ".env.sample") return false;
  return filename === ".env" || filename.startsWith(".env.");
}




export function inferProjectMetadata(files) {
  const paths = files.map((f) => f.path);
  const packageJson = files.find((f) => f.path === "package.json");
  const pyproject = files.find((f) => f.path === "pyproject.toml");
  const pom = files.find((f) => f.path === "pom.xml");
  const csharpProj = files.find((f) => f.path.endsWith(".csproj"));
  const goMod = files.find((f) => f.path === "go.mod");

  let language = "unknown";
  let techStack = [];

  if (packageJson) {
    language = "javascript";
    try {
      const pkg = JSON.parse(packageJson.content);
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        techStack.push("typescript");
      }
      if (pkg.devDependencies?.react || pkg.dependencies?.react) {
        techStack.push("react");
      }
      if (pkg.devDependencies?.express || pkg.dependencies?.express) {
        techStack.push("express");
      }
      if (pkg.devDependencies?.vite) {
        techStack.push("vite");
      }
    } catch {
      
    }
  } else if (pyproject) {
    language = "python";
    techStack.push("python");
  } else if (pom) {
    language = "java";
    techStack.push("java");
    techStack.push("maven");
  } else if (csharpProj) {
    language = "csharp";
    techStack.push("csharp");
  } else if (goMod) {
    language = "go";
    techStack.push("go");
  }


  if (paths.some((p) => p.includes("docker"))) {
    techStack.push("docker");
  }
  if (paths.some((p) => p.includes("kubernetes"))) {
    techStack.push("kubernetes");
  }
  if (paths.some((p) => p.includes("terraform"))) {
    techStack.push("terraform");
  }

  return {
    language,
    techStack: [...new Set(techStack)],
    fileCount: files.length,
  };
}



export function formatZipError(error) {
  if (error.message.includes("ZIP")) {
    return error.message;
  }
  return `Failed to process ZIP file: ${error.message}`;
}
