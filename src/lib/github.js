const { Octokit } = require("@octokit/core");
const path = require("path");
const fs = require('fs');

const { download } = require("./download");
const micromatch = require('./micromatch');

const octokit = new Octokit({
  userAgent: "yanc"
});

function _parseRepoUrl(repoUrl) {
  // github:user/repo[/branch]
  let res = repoUrl.split("/");
  if (res.length > 3 || res.length < 2) return null;

  const owner = res[0].split(":");
  if (owner.length > 2) return null;
  const repo = res[1];
  const ref = res.length === 3 ? res[2]:"";
  return {
    server: owner.length === 2 ? owner[0] : "github",
    owner: owner.length === 1 ? owner[0] : owner[1],
    repo,
    ref,
  };
}

function _makeDownloadUrl(repoInfo, blob) {
  return `https://raw.githubusercontent.com/${repoInfo.owner}/${repoInfo.repo}/${repoInfo.ref}/${blob.path}`;
}

async function _downloadBlobsInTree(repoInfo, tree, {outdir, force, dryrun}) {
  /*
  BLOB(Binary Large Object) item:
    {
      path: '.gitignore',
      mode: '100644',
      type: 'blob',
      sha: '67045665db202cf951f839a5f3e73efdcfd45021',
      size: 1610,
      url: 'https://api.github.com/repos/aistyler/yanc/git/blobs/67045665db202cf951f839a5f3e73efdcfd45021'
    },
  */
  const toBeDownloaded = tree.filter((e) => e.mode !== "040000" && (force || !fs.existsSync(path.join(outdir, e.path))));
  const promiseAll = toBeDownloaded.map((item) => {
    const filePath = path.join(outdir, item.path);

    return dryrun 
      ? `${filePath} from ${_makeDownloadUrl(repoInfo, item)}` 
      : download(_makeDownloadUrl(repoInfo, item), { path: filePath });
  });
  return await Promise.all(promiseAll);
}

async function downloadFromGithub(repoUrl, globPattern, options) {
  const repoInfo = _parseRepoUrl(repoUrl);
  if (!repoInfo) {
    console.error("!!! Invalid repository,", repoUrl);
    console.error("!!! Expected format: {owner}/{repo-name}[/{branch-name}]");
    return;
  }

  if (globPattern && globPattern.length > 0 && options.topLevelDot) {
    globPattern.push("./.*"); // add top-level 
  }

  // override ref
  if (options.branch) {
    if (repoInfo.ref) console.warn("*** The target ref is overrided with the specified branch.");
    repoInfo.ref = options.branch;
  }
  if (options.tag) {
    if (options.branch) console.warn("*** The target ref is overrided with the specified tag.");
    repoInfo.ref = options.tag;
  }
  if (!repoInfo.ref) {
    // default use 'main' branch name
    repoInfo.ref = "main";
  }

  if (options.dryrun)
    console.log(`Try to test files of ${repoInfo.ref} from ${repoUrl}`);
  else
    console.log(`Try to download files of ${repoInfo.ref} from ${repoUrl}`);

  //
  // get ref info
  let refInfo;
  try {
    // See https://docs.github.com/en/rest/reference/repos
    refInfo = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      accept: "application/vnd.github.v3+json",
      ...repoInfo,
      ref: options.tag ? `tags/${repoInfo.ref}` : `heads/${repoInfo.ref}`,
    });
  } catch (e) {
    console.error(`!!! Failed to retrieve the information of the branch:`, e.message);
    console.error(`!!! Parsed repo info: "${repoInfo.ref}" in "${repoInfo.owner}/${repoInfo.repo}"`);
    return;
  }
  console.log("SHA of target ref:", refInfo.data.object.sha);

  //
  // get tree info
  let treeInfo;
  try {
    treeInfo = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      accept: "application/vnd.github.v3+json",
      ...repoInfo,
      tree_sha: refInfo.data.object.sha,
      recursive: "true",
    });
  } catch (e) {
    console.error(`!!! Failed to retrieve the tree info:`, e.message);
    return;
  }
  let toBeDownloaded = treeInfo.data.tree.filter((e) => e.type === "blob"); // download "blob" only
  console.log("# of files on the repository:", toBeDownloaded.length);
  options.verbose && toBeDownloaded.forEach((e) => console.log("  ", e.path));

  //
  // apply glob pattern
  if (globPattern && globPattern.length > 0) {
    toBeDownloaded = toBeDownloaded.filter((e) => micromatch.isMatch(e.path, globPattern));
    console.log("# of files applied glob pattern:", toBeDownloaded.length);
    if (options.verbose) {
      const ignored = treeInfo.data.tree.filter((e) => e.type === "blob" && !toBeDownloaded.find((ee) => e.path === ee.path));
      console.log("Ignored files: ", !ignored ? 0 : ignored.length);
      ignored.forEach((e) => console.log("  -", e.path));
    }
  }

  //
  // download package.json if available
  const packageJsonItem = toBeDownloaded.find((e) => e.path === "package.json");
  let packageJson;
  if (packageJsonItem) {
    packageJson = await download(_makeDownloadUrl(repoInfo, packageJsonItem), {});
    packageJson = JSON.parse(packageJson);

    const { yancIgnore } = packageJson;
    if (yancIgnore) {
      //console.log("Apply ignore files from package.json:", yancIgnore);
      //toBeDownloaded = toBeDownloaded.filter((e) => !micromatch.isMatch(e.path, yancIgnore));
    }
  }
  console.log("# of files to be downloaded:", toBeDownloaded.length);

  try {
    const res = await _downloadBlobsInTree(repoInfo, toBeDownloaded, options);
    console.log("# of files downloaded:", res.length);
    if (options.dryrun) {
      console.log(res);
    }
  } catch (e) {
    console.error(`!!! Failed to downlaod files from github:`, e.message);
  }
}

module.exports = {
  downloadFromGithub,
};
