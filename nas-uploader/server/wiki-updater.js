import { promises as fs } from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_WIKI_BASE = '/home/darklee/wiki/latest/wiki-documents';

function getWikiBase(options = {}) {
  return options.wikiBase || DEFAULT_WIKI_BASE;
}

function getL4TDataPath(options = {}) {
  return path.join(getWikiBase(options), 'src/data/jetson/L4TData.json');
}

/**
 * Parse an NAS filename to extract product metadata.
 * Filename patterns:
 *   mfi_recomputer-{series}-{module}-{ram}-{carrier}-{jp}-{l4t}-{date}.{ext}
 *   mfi_recomputer-{module}-{ram}-{series}-{jp}-{l4t}-{date}.{ext}  (classic/industrial variants)
 *   mfi_reserver-{module}-{carrier}-{jp}-{l4t}-{date}.{ext}
 */
export function parseNasFilename(basename) {
  // Remove extension
  const name = basename.replace(/\.(tar\.gz|tar|zip)$/, '');

  // Try to match: mfi_recomputer-<series>-<module>-<ram>-<carrier>-<jp>-<l4t>-<date>
  // or: mfi_recomputer-<module>-<ram>-<series>-<jp>-<l4t>-<date>
  // or: mfi_reserver-<module>-<carrier>-<jp>-<l4t>-<date>

  // Detect format type from filename
  const knownSeries = ['super', 'mini', 'robo', 'robotics', 'classic', 'industrial'];

  // Type A: mfi_recomputer-{series}-{module}-{ram}-{carrier}-{jp}-{l4t}-{date}
  // e.g. mfi_recomputer-super-orin-nx-16g-j401-6.2-36.4.3-2026-02-05
  const typeAMatch = name.match(/^mfi_recomputer-(super|mini|robo|robotics)-([a-z]+(?:-[a-z]+)*)-(\d+g)-([\w-]+)-(\d+\.\d+(?:\.\d+)?)-(\d+\.\d+\.\d+)(?:-(.+))?$/);
  if (typeAMatch) {
    const [, series, module, ram, carrier, jetpack, l4t, date] = typeAMatch;
    return { series, module, ram, carrier, jetpack, l4t, date: date || null, basename };
  }

  // Type B: mfi_recomputer-{module}-{ram}-{series}-{jp}-{l4t}-{date}
  // e.g. mfi_recomputer-orin-nx-16g-industrial-5.1-35.5.0-2026-02-10
  const typeBMatch = name.match(/^mfi_recomputer-([a-z]+(?:-[a-z]+)*)-(\d+g)-(classic|industrial)-(\d+\.\d+(?:\.\d+)?)-(\d+\.\d+\.\d+)(?:-(.+))?$/);
  if (typeBMatch) {
    const [, module, ram, series, jetpack, l4t, date] = typeBMatch;
    return { series, module, ram, carrier: null, jetpack, l4t, date: date || null, basename };
  }

  // Type C: mfi_reserver-{module}-{ram}-{carrier}-{jp}-{l4t}-{date}
  // e.g. mfi_reserver-agx-orin-64g-j501-6.2-36.4.3-2025-04-02
  const typeCMatch = name.match(/^mfi_reserver-([a-z]+(?:-[a-z]+)*)-(\d+g)-([\w-]+)-(\d+\.\d+(?:\.\d+)?)-(\d+\.\d+\.\d+)(?:-(.+))?$/);
  if (typeCMatch) {
    const [, module, ram, carrier, jetpack, l4t, date] = typeCMatch;
    return { series: 'reserver', module, ram, carrier, jetpack, l4t, date: date || null, basename };
  }

  return null;
}

/**
 * Derive L4TData product ID from parsed filename metadata.
 * Returns { product, l4t } or null if cannot derive.
 */
export function deriveProductId(parsed) {
  if (!parsed) return null;

  const { module, ram, carrier, series, l4t } = parsed;

  // RAM code: 16g -> 2, 8g -> 1, 4g -> 0, 32g -> 3, 64g -> 4
  const ramMap = { '16g': '2', '8g': '1', '4g': '0', '32g': '3', '64g': '4', '16q': '2', '8q': '1' };
  const ramCode = ramMap[ram];
  if (!ramCode) return null;

  // Series suffix mapping
  const seriesMap = {
    'super': 's',
    'mini': 'mini',
    'robotics': 'robotics',
    'robo': 'robotics',
    'classic': 'classic',
    'industrial': 'industrial',
    'reserver': 'reserver',
  };
  const seriesSuffix = seriesMap[series];
  if (!seriesSuffix) return null;

  // J501 series uses descriptive naming, not numeric codes
  if (module === 'agx-orin' && carrier && carrier.startsWith('j501')) {
    if (seriesSuffix === 'reserver') {
      return { product: `j501-carrier AGX-Orin ${ram}`, l4t };
    } else if (seriesSuffix === 'mini') {
      return { product: `j501mini-agx-orin-${ram}`, l4t };
    } else if (seriesSuffix === 'robotics') {
      return { product: `j501-agx-orin-${ram}`, l4t };
    }
  }

  // Module prefix mapping
  // orin-nx -> 401, orin-nano -> 301, agx-orin -> 501, xavier-nx -> 201, jetson-nano -> 101
  const modulePrefixMap = {
    'orin-nx': '401',
    'orin-nano': '301',
    'agx-orin': '501',
    'xavier-nx': '201',
    'jetson-nano': '101',
    'nx': '401',
    'nano': '301',
  };

  let prefix = modulePrefixMap[module];
  if (!prefix) {
    // Fallback: try to infer from carrier
    if (carrier && (carrier.startsWith('j401') || carrier.startsWith('j40'))) prefix = '401';
    else if (carrier && (carrier.startsWith('j30') || carrier.startsWith('j30'))) prefix = '301';
    else if (carrier && carrier.startsWith('j501')) prefix = '501';
    else if (carrier && carrier.startsWith('j201')) prefix = '201';
    else if (carrier && carrier.startsWith('j101')) prefix = '101';
  }
  if (!prefix) return null;

  const product = `j${prefix}${ramCode}${seriesSuffix}`;
  return { product, l4t };
}

/**
 * Find the corresponding chksum file in NAS for a given mfi file.
 */
export async function findChksumFile(nasRoot, mfiBasename) {
  // chksum filename pattern: chksum-{product-name}-{date}.txt
  // e.g. mfi_recomputer-super-orin-nx-16g-j401-6.2-36.4.3-2026-02-05.tar.gz
  //      -> chksum-recomputer-super-orin-nx-16g-j401-2026-02-05.txt
  const name = mfiBasename.replace(/\.(tar\.gz|tar|zip)$/, '');
  const parts = name.split('-');
  // Remove 'mfi', 'recomputer' or 'reserver', and the jetpack/l4t parts
  // Heuristic: remove first token (mfi), second token (recomputer/reserver),
  // then find jetpack version (starts with digit) and remove it and everything after up to date

  // Try pattern: chksum-{rest}-{date}.txt where rest is everything after mfi_ prefix excluding jetpack/l4t
  // Simple approach: search NAS for chksum files matching the base product name and date
  const dateMatch = name.match(/(\d{4}-\d{2}-\d{2})$/);
  if (!dateMatch) return null;
  const date = dateMatch[1];

  // Build candidate names
  // Build candidate chksum filenames
  const candidates = [];
  if (name.includes('recomputer-')) {
    // mfi_recomputer-{series}-{module}-{ram}-{carrier}-{jp}-{l4t}-{date}
    // -> chksum-{series}-{module}-{ram}-{carrier}-{date}
    const m = name.match(/^mfi_recomputer-(.+)-(\d+\.\d+(?:\.\d+)?)-(\d+\.\d+\.\d+)-(\d{4}-\d{2}-\d{2})$/);
    if (m) {
      const [, base, , , d] = m;
      candidates.push(`chksum-${base}-${d}.txt`);
    }
    // Also try without series prefix for classic/industrial
    const m2 = name.match(/^mfi_recomputer-([a-z]+(?:-[a-z]+)*)-(\d+g)-([a-z]+)-(\d+\.\d+(?:\.\d+)?)-(\d+\.\d+\.\d+)-(\d{4}-\d{2}-\d{2})$/);
    if (m2) {
      const [, mod, ram, series, , , d] = m2;
      candidates.push(`chksum-${series}-${mod}-${ram}-${d}.txt`);
      // Some chksum files omit the series
      candidates.push(`chksum-recomputer-${series}-${mod}-${ram}-${d}.txt`);
    }
  }
  if (name.includes('reserver-')) {
    const m = name.match(/^mfi_reserver-(.+)-(\d+\.\d+(?:\.\d+)?)-(\d+\.\d+\.\d+)-(\d{4}-\d{2}-\d{2})$/);
    if (m) {
      const [, base, , , d] = m;
      candidates.push(`chksum-${base}-${d}.txt`);
    }
  }

  for (const cand of candidates) {
    const candPath = path.join(nasRoot, cand);
    try {
      await fs.access(candPath);
      return candPath;
    } catch {}
  }

  // Fallback: search for chksum file that contains the basename (excluding mfi_ prefix) in its name
  try {
    const entries = await fs.readdir(nasRoot);
    const baseName = name.replace(/^mfi_(recomputer|reserver)-/, '');
    for (const entry of entries) {
      if (entry.startsWith('chksum-') && entry.endsWith('.txt')) {
        // Check if entry contains key identifying parts
        const entryBase = entry.replace(/^chksum-/, '').replace(/-\d{4}-\d{2}-\d{2}\.txt$/, '');
        if (baseName.includes(entryBase) || entryBase.includes(baseName.split('-').slice(0, 4).join('-'))) {
          return path.join(nasRoot, entry);
        }
      }
    }
  } catch {}

  return null;
}

/**
 * Read SHA256 from chksum file.
 */
export async function readSha256(chksumPath) {
  if (!chksumPath) return null;
  try {
    const content = await fs.readFile(chksumPath, 'utf-8');
    // Expected format: <sha256>  <filename>
    const m = content.trim().match(/^([a-fA-F0-9]+)\s+/);
    return m ? m[1].toUpperCase() : content.trim().split(/\s+/)[0].toUpperCase();
  } catch {
    return null;
  }
}

/**
 * Update L4TData.json with new OneDrive link.
 * Strategy:
 *   1. Try exact filename match
 *   2. Fallback to (product, l4t) match derived from filename
 */
export async function updateL4TData(nasRoot, oneDriveLink, mfiBasename, options = {}) {
  const l4tDataPath = getL4TDataPath(options);
  const l4tData = JSON.parse(await fs.readFile(l4tDataPath, 'utf-8'));

  // Strategy 1: exact filename match
  const exactMatches = l4tData.filter(item => item.filename === mfiBasename);
  if (exactMatches.length > 0) {
    for (const item of exactMatches) {
      item.mainlink = oneDriveLink;
      // Optionally update sha256
      const chksumPath = await findChksumFile(nasRoot, mfiBasename);
      const sha256 = await readSha256(chksumPath);
      if (sha256) item.sha256 = sha256;
    }
    await fs.writeFile(l4tDataPath, JSON.stringify(l4tData, null, 4) + '\n');
    return { updated: exactMatches.length, matches: exactMatches.map(x => x.product) };
  }

  // Strategy 2: derive product from filename
  const parsed = parseNasFilename(mfiBasename);
  const derived = deriveProductId(parsed);
  if (!derived) {
    return { updated: 0, error: `Cannot derive product ID from filename: ${mfiBasename}` };
  }

  const { product, l4t } = derived;
  // Some l4t values in L4TData.json have GMSL suffixes like "36.3.0 (GMSL✅)"
  // Try exact match first, then fuzzy match on base l4t version
  let derivedMatches = l4tData.filter(item => item.product === product && item.l4t === l4t);
  if (derivedMatches.length === 0) {
    derivedMatches = l4tData.filter(item => {
      if (item.product !== product) return false;
      const baseL4t = String(item.l4t).replace(/\s*\(GMSL[✅❌]\)\s*$/, '').trim();
      return baseL4t === l4t;
    });
  }
  if (derivedMatches.length === 0) {
    return { updated: 0, error: `No L4TData entry found for product=${product} l4t=${l4t}` };
  }

  for (const item of derivedMatches) {
    item.mainlink = oneDriveLink;
    item.filename = mfiBasename;
    const chksumPath = await findChksumFile(nasRoot, mfiBasename);
    const sha256 = await readSha256(chksumPath);
    if (sha256) item.sha256 = sha256;
  }

  await fs.writeFile(l4tDataPath, JSON.stringify(l4tData, null, 4) + '\n');
  return { updated: derivedMatches.length, matches: derivedMatches.map(x => x.product) };
}

/**
 * Run a git command in the wiki repo.
 */
function git(args, options = {}) {
  return new Promise((resolve, reject) => {
    const cwd = options.cwd || getWikiBase(options);
    const proc = spawn('git', args, { cwd, ...options });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr || stdout}`));
    });
  });
}

/**
 * Find wiki documents that contain a given OneDrive link.
 * Returns array of relative paths from WIKI_BASE.
 */
export async function findDocsContainingLink(link, options = {}) {
  try {
    const { stdout } = await execFileAsync('grep', ['-rl', link, 'sites/en/docs/Edge/NVIDIA_Jetson/'], {
      cwd: getWikiBase(options),
      timeout: 30000,
    });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Replace old OneDrive link and optional SHA256 in a wiki document.
 */
export async function replaceLinkInDoc(relPath, oldLink, newLink, oldSha256, newSha256, options = {}) {
  const absPath = path.join(getWikiBase(options), relPath);
  let content = await fs.readFile(absPath, 'utf-8');
  let changed = false;

  if (content.includes(oldLink)) {
    content = content.split(oldLink).join(newLink);
    changed = true;
  }

  if (oldSha256 && newSha256 && content.includes(oldSha256)) {
    content = content.split(oldSha256).join(newSha256);
    changed = true;
  }

  if (changed) {
    await fs.writeFile(absPath, content);
  }

  return { changed, path: relPath };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveDocJetpackVersions(item, parsed) {
  const versions = new Set();

  const folderVersion = item?.foldername?.match(/-(\d+\.\d+(?:\.\d+)?)-\d+\.\d+\.\d+$/)?.[1];
  if (folderVersion) versions.add(folderVersion);
  if (parsed?.jetpack) versions.add(parsed.jetpack);

  const l4tToJetpack = {
    '35.3.1': '5.1.1',
    '35.4.1': '5.1.2',
    '35.5.0': '5.1.3',
    '36.2.0': '6.0',
    '36.3.0': '6.0',
    '36.4.0': '6.1',
    '36.4.3': '6.2',
  };
  if (item?.l4t && l4tToJetpack[item.l4t]) {
    versions.add(l4tToJetpack[item.l4t]);
  }

  return [...versions];
}

function deriveDeviceLabels(product) {
  const labels = [];
  const simpleMatch = String(product || '').match(/^j(\d{3})(\d)([a-z]+)$/);
  if (!simpleMatch) return labels;

  const [, prefix, ramCode, suffix] = simpleMatch;
  const board = `J${prefix}${ramCode}`;
  const prefixMap = {
    industrial: [`reComputer Industrial ${board}`],
    s: [`reComputer Super ${board}`],
    mini: [`reComputer Mini ${board}`],
    robotics: [`reComputer Robotics ${board}`],
    classic: [`reComputer ${board}`],
    reserver: [`reServer Industrial ${board}`, `reServer ${board}`],
  };

  return prefixMap[suffix] || labels;
}

function deriveModuleLabels(parsed) {
  if (!parsed?.module || !parsed?.ram) return [];

  const moduleLabelMap = {
    'orin-nx': 'Orin NX',
    'orin-nano': 'Orin Nano',
    'agx-orin': 'AGX Orin',
    'xavier-nx': 'Xavier NX',
    'jetson-nano': 'Jetson Nano',
  };

  const moduleLabel = moduleLabelMap[parsed.module] || parsed.module
    .split('-')
    .map(part => part.toUpperCase() === 'NX' ? 'NX' : part.toUpperCase() === 'AGX' ? 'AGX' : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');

  const ram = parsed.ram.replace(/g$/i, 'GB').replace(/q$/i, 'GB');
  return [
    `${moduleLabel} ${ram}`,
    `${moduleLabel}${ram.startsWith(' ') ? ram : ` ${ram}`}`,
  ];
}

function buildJetpackSectionMatchers(versions) {
  const labels = new Set();
  for (const version of versions) {
    labels.add(`Jetpack ${version}`);
    labels.add(`Jetpack${version}`);
    labels.add(`JetPack ${version}`);
    labels.add(`JetPack${version}`);
  }
  return [...labels];
}

async function findStructuredDownloadDocs(options = {}) {
  const wikiBase = getWikiBase(options);
  const { stdout } = await execFileAsync(
    'find',
    [
      path.join(wikiBase, 'sites'),
      '-type', 'f',
      '(',
      '-name', '*Getting_Started*.md',
      '-o', '-name', '*Getting_Started*.mdx',
      '-o', '-name', '*Hardware_Interfaces*.md',
      '-o', '-name', '*Hardware_Interfaces*.mdx',
      '-o', '-name', '*Hardware_Interface*.md',
      '-o', '-name', '*Hardware_Interface*.mdx',
      ')',
    ],
    { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((absPath) => path.relative(wikiBase, absPath));
}

function replaceRowInTabSection(section, rowLabels, newLink, newSha256) {
  for (const rowLabel of rowLabels) {
    const rowRegex = new RegExp(
      `(<tr>[\\s\\S]*?<t[dh][^>]*>\\s*${escapeRegExp(rowLabel)}\\s*<\\/t[dh]>[\\s\\S]*?<td><a href=")([^"]+)("([^>]*)>Download<\\/a><\\/td>[\\s\\S]*?<t[dh][^>]*>)([\\s\\S]*?)(<\\/t[dh]>[\\s\\S]*?<\\/tr>)`,
      's'
    );
    if (!rowRegex.test(section)) continue;

    return section.replace(rowRegex, (_match, p1, _oldLink, p3, _attrs, oldSha, p6) =>
      `${p1}${newLink}${p3}${newSha256 || oldSha}${p6}`
    );
  }
  return section;
}

export async function updateGettingStartedDocs(item, parsed, oneDriveLink, newSha256, options = {}) {
  const deviceLabels = deriveDeviceLabels(item?.product);
  const moduleLabels = deriveModuleLabels(parsed);
  const rowLabels = [...new Set([...deviceLabels, ...moduleLabels])];
  const jetpackVersions = deriveDocJetpackVersions(item, parsed);
  const sectionMatchers = buildJetpackSectionMatchers(jetpackVersions);

  if (rowLabels.length === 0 || sectionMatchers.length === 0) {
    return [];
  }

  const docs = await findStructuredDownloadDocs(options);
  const changedDocs = [];

  for (const relPath of docs) {
    const absPath = path.join(getWikiBase(options), relPath);
    let content = await fs.readFile(absPath, 'utf-8');

    if (!rowLabels.some(label => content.includes(label))) continue;
    const tabRegex = /<TabItem\b[\s\S]*?<\/TabItem>/g;
    let changed = false;
    const hasTabs = tabRegex.test(content);
    tabRegex.lastIndex = 0;

    if (hasTabs) {
      content = content.replace(tabRegex, (section) => {
        if (!sectionMatchers.some(label => section.includes(label))) {
          return section;
        }
        const updated = replaceRowInTabSection(section, rowLabels, oneDriveLink, newSha256);
        if (updated !== section) changed = true;
        return updated;
      });
    } else {
      const updated = replaceRowInTabSection(content, rowLabels, oneDriveLink, newSha256);
      if (updated !== content) {
        content = updated;
        changed = true;
      }
    }

    if (changed) {
      await fs.writeFile(absPath, content);
      changedDocs.push(relPath);
    }
  }

  return changedDocs;
}

/**
 * Update wiki docs (both L4TData.json and individual tutorial docs).
 * Returns summary of all changes.
 */
export async function updateWikiDocs(nasRoot, oneDriveLink, mfiBasename, options = {}) {
  const modifiedFiles = [];
  const l4tDataPath = getL4TDataPath(options);
  const parsed = parseNasFilename(mfiBasename);
  const chksumPath = await findChksumFile(nasRoot, mfiBasename);
  const newSha256 = await readSha256(chksumPath);

  // Step 1: Find matching L4TData entries BEFORE updating, so we know old links
  const l4tData = JSON.parse(await fs.readFile(l4tDataPath, 'utf-8'));

  // Try exact filename match first
  let exactMatches = l4tData.filter(item => item.filename === mfiBasename);

  // Fallback to derived product match
  if (exactMatches.length === 0) {
    const derived = deriveProductId(parsed);
    if (derived) {
      const { product, l4t } = derived;
      exactMatches = l4tData.filter(item => item.product === product && item.l4t === l4t);
      if (exactMatches.length === 0) {
        exactMatches = l4tData.filter(item => {
          if (item.product !== product) return false;
          const baseL4t = String(item.l4t).replace(/\s*\(GMSL[✅❌]\)\s*$/, '').trim();
          return baseL4t === l4t;
        });
      }
    }
  }

  // Step 2: Replace old links in individual tutorial docs
  const docReplacements = [];
  for (const item of exactMatches) {
    const oldLink = item.mainlink;
    const oldSha256 = item.sha256;
    const targetSha256 = newSha256 || item.sha256 || oldSha256;
    if (oldLink && oldLink !== oneDriveLink) {
      const docs = await findDocsContainingLink(oldLink, options);
      for (const doc of docs) {
        const result = await replaceLinkInDoc(doc, oldLink, oneDriveLink, oldSha256, targetSha256, options);
        if (result.changed) {
          docReplacements.push(doc);
          if (!modifiedFiles.includes(doc)) modifiedFiles.push(doc);
        }
      }
    }

    const fallbackDocs = await updateGettingStartedDocs(item, parsed, oneDriveLink, targetSha256, options);
    for (const doc of fallbackDocs) {
      if (!docReplacements.includes(doc)) docReplacements.push(doc);
      if (!modifiedFiles.includes(doc)) modifiedFiles.push(doc);
    }
  }

  // Step 3: Update L4TData.json
  const l4tResult = await updateL4TData(nasRoot, oneDriveLink, mfiBasename, options);
  if (l4tResult.updated > 0) {
    modifiedFiles.push('src/data/jetson/L4TData.json');
  }

  return { l4t: l4tResult, docs: docReplacements, modifiedFiles };
}

/**
 * Commit and push wiki changes.
 */
async function getCurrentBranch(options = {}) {
  return git(['branch', '--show-current'], options);
}

async function pushWikiChanges(remote, branch, options = {}) {
  await git(['push', remote, `HEAD:${branch}`], options);
}

export async function commitWikiChanges(message, files = [], options = {}) {
  // Configure git user if not already set
  try { await git(['config', 'user.email'], options); } catch {
    await git(['config', 'user.email', 'nas-uploader@local'], options);
  }
  try { await git(['config', 'user.name'], options); } catch {
    await git(['config', 'user.name', 'NAS Uploader'], options);
  }

  // Stage files
  if (files.length > 0) {
    await git(['add', ...files], options);
  } else {
    await git(['add', '-A'], options);
  }

  let hasStagedChanges = true;
  try {
    await git(['diff', '--cached', '--quiet'], options);
    hasStagedChanges = false;
  } catch {
    hasStagedChanges = true;
  }

  if (!hasStagedChanges) {
    return { committed: false, reason: 'No staged changes to commit' };
  }

  // Commit
  await git(['commit', '-m', message], options);

  const remote = options.remote || 'origin';
  const branch = options.branch || await getCurrentBranch(options);

  // Push, and if the remote moved meanwhile, rebase and retry once.
  let pushed = false;
  let pushError = null;
  let rebased = false;
  try {
    await pushWikiChanges(remote, branch, options);
    pushed = true;
  } catch (err) {
    try {
      await git(['fetch', remote, branch], options);
      await git(['rebase', `${remote}/${branch}`], options);
      rebased = true;
      await pushWikiChanges(remote, branch, options);
      pushed = true;
    } catch (retryErr) {
      try {
        const rebaseHead = path.join(getWikiBase(options), '.git', 'rebase-merge');
        await fs.access(rebaseHead);
        await git(['rebase', '--abort'], options);
      } catch {
        // No active rebase to abort.
      }
      pushError = `${err.message}\nRetry failed: ${retryErr.message}`;
    }
  }

  return { committed: true, pushed, pushError, remote, branch, rebased };
}
