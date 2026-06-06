const fs = require('fs');
const { execSync } = require('child_process');

// Get arguments
const tagName = process.argv[2];
if (!tagName) {
  console.error('Error: Tag name is required as first argument.');
  process.exit(1);
}

// Find previous tag
let prevTag = '';
try {
  prevTag = execSync(`git describe --tags --abbrev=0 ${tagName}^ 2>/dev/null`, { encoding: 'utf-8' }).trim();
} catch (e) {
  // No previous tag found
}

console.log(`Current Tag: ${tagName}`);
console.log(`Previous Tag: ${prevTag}`);

// Get commits
let logCmd = `git log ${tagName} --pretty=format:"%s (%h)"`;
if (prevTag) {
  logCmd = `git log ${prevTag}..${tagName} --pretty=format:"%s (%h)"`;
}

let commits = [];
try {
  const output = execSync(logCmd, { encoding: 'utf-8' });
  commits = output.split('\n').map(line => line.trim()).filter(line => line.length > 0);
} catch (e) {
  console.error('Error fetching git log:', e);
}

// Define categories mapping to headings (without emoticons)
const CATEGORY_MAP = {
  feat: 'Features',
  fix: 'Bug Fixes',
  perf: 'Performance Improvements'
};

const EXCLUDED_TYPES = ['doc', 'docs', 'chore', 'style', 'refactor', 'test', 'ci', 'build'];

const groups = {};
Object.values(CATEGORY_MAP).forEach(title => {
  groups[title] = [];
});
const miscTitle = 'Other Changes';
groups[miscTitle] = [];

commits.forEach(commit => {
  // Match prefix and optional scope, e.g., feat(scope): message (%h)
  const match = commit.match(/^(feat|fix|perf|refactor|docs|doc|chore|test|ci|style|build)(?:\(([^)]+)\))?:\s*(.*)$/i);
  if (match) {
    const type = match[1].toLowerCase();
    
    // Skip excluded commit types completely
    if (EXCLUDED_TYPES.includes(type)) {
      return;
    }
    
    const scope = match[2];
    const message = match[3];
    const groupTitle = CATEGORY_MAP[type] || miscTitle;
    
    // Capitalize first letter of the message for a cleaner look
    const capitalizedMessage = message.charAt(0).toUpperCase() + message.slice(1);
    
    const formattedMessage = scope 
      ? `* **${scope}**: ${capitalizedMessage}`
      : `* ${capitalizedMessage}`;
      
    groups[groupTitle].push(formattedMessage);
  } else {
    // If it's a merge commit or standard push update (like changelog updates), filter it out to keep release notes clean
    if (commit.startsWith('Merge branch') || commit.startsWith('chore: update CHANGELOG.md')) {
      return;
    }
    groups[miscTitle].push(`* ${commit}`);
  }
});

// Build markdown content for changelog and release notes
let changelogBody = '';
Object.keys(groups).forEach(title => {
  if (groups[title].length > 0) {
    changelogBody += `### ${title}\n\n`;
    groups[title].forEach(item => {
      changelogBody += `${item}\n`;
    });
    changelogBody += '\n';
  }
});

if (changelogBody.trim().length === 0) {
  changelogBody = '* No significant changes in this release.\n';
}

// Write release notes to /tmp/release_notes.md
const releaseNotesPath = '/tmp/release_notes.md';
const releaseNotesContent = `## Changes in ${tagName}\n\n${changelogBody}`;
fs.writeFileSync(releaseNotesPath, releaseNotesContent, 'utf-8');
console.log(`Generated release notes at ${releaseNotesPath}`);

// Update CHANGELOG.md in place
const changelogPath = 'CHANGELOG.md';
const date = new Date().toISOString().split('T')[0];
const versionHeader = `## [${tagName}] - ${date}\n\n${changelogBody}`;

let existingContent = '';
if (fs.existsSync(changelogPath)) {
  existingContent = fs.readFileSync(changelogPath, 'utf-8');
}

let newChangelogContent = '';
if (existingContent.trim().length > 0) {
  if (existingContent.startsWith('# Changelog')) {
    const lines = existingContent.split('\n');
    const firstVersionIndex = lines.findIndex(line => line.trim().startsWith('## ['));
    if (firstVersionIndex !== -1) {
      const headerPart = lines.slice(0, firstVersionIndex).join('\n');
      const bodyPart = lines.slice(firstVersionIndex).join('\n');
      newChangelogContent = `${headerPart.trim()}\n\n${versionHeader}\n${bodyPart}`;
    } else {
      newChangelogContent = `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n${versionHeader}\n\n${existingContent.replace(/# Changelog\s*/, '')}`;
    }
  } else {
    newChangelogContent = `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n${versionHeader}\n\n${existingContent}`;
  }
} else {
  newChangelogContent = `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n${versionHeader}`;
}

fs.writeFileSync(changelogPath, newChangelogContent, 'utf-8');
console.log(`Updated CHANGELOG.md successfully.`);

// Update manifest.json and package.json versions to match tag (without 'v' prefix)
const rawVersion = tagName.startsWith('v') ? tagName.slice(1) : tagName;

const packagePath = 'package.json';
if (fs.existsSync(packagePath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
    pkg.version = rawVersion;
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    console.log(`Updated ${packagePath} version to ${rawVersion}`);
  } catch (e) {
    console.error(`Error updating package.json:`, e);
  }
}

const manifestPath = 'manifest.json';
if (fs.existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.version = rawVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    console.log(`Updated ${manifestPath} version to ${rawVersion}`);
  } catch (e) {
    console.error(`Error updating manifest.json:`, e);
  }
}
