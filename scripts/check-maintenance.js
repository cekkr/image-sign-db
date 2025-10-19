#!/usr/bin/env node
/**
 * Maintenance checklist guardrail.
 *
 * Ensures that when core technical areas change, accompanying documentation
 * updates are staged alongside. Mirrors TECH_NOTES.md §18 rules.
 */

const { execSync } = require('child_process');
const path = require('path');

function collectChangedFiles() {
  try {
    const output = execSync('git status --porcelain', {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    const files = new Set();
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      // Format: XY path or XY path -> newpath
      const parts = line.trim().split(/\s+/);
      const filePath = parts[parts.length - 1];
      if (filePath && filePath !== '->') {
        files.add(filePath);
      }
    }
    return files;
  } catch (error) {
    console.warn('⚠️  Unable to determine changed files via git:', error.message);
    return new Set();
  }
}

function hasMatch(changed, target) {
  if (!target) return false;
  if (changed.has(target)) return true;
  // Directory prefix check
  const prefix = target.endsWith('/') ? target : `${target}/`;
  for (const file of changed) {
    if (file === target) return true;
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

const RULES = [
  {
    description:
      'Augmentation or descriptor changes must document updates in README.md and TECH_NOTES.md.',
    triggers: [
      'src/lib/augmentations.js',
      'src/lib/constants.js',
      'src/lib/constellation.js',
      'src/lib/vectorGenerators.js',
      'src/lib/vectorSpecs.js',
      'src/lib/descriptor.js',
      'src/featureExtractor.js',
    ],
    required: ['README.md', 'TECH_NOTES.md'],
  },
  {
    description:
      'Environment flag changes need README.md and TECH_NOTES.md updates.',
    triggers: ['src/settings.js'],
    required: ['README.md', 'TECH_NOTES.md'],
  },
  {
    description:
      'Schema migrations must be accompanied by TECH_NOTES.md updates.',
    triggers: ['src/setupDatabase.js', 'src/lib/schema.js'],
    required: ['TECH_NOTES.md'],
  },
  {
    description:
      'Search/session flow updates must refresh docs for README.md and TECH_NOTES.md.',
    triggers: ['src/index.js', 'src/clientAPI.js'],
    required: ['README.md', 'TECH_NOTES.md'],
  },
];

function main() {
  const changed = collectChangedFiles();
  if (changed.size === 0) {
    console.log('ℹ️  No changes detected; maintenance checklist skipped.');
    return;
  }

  const violations = [];
  for (const rule of RULES) {
    const triggered = rule.triggers.some((target) => hasMatch(changed, target));
    if (!triggered) continue;
    const satisfied = rule.required.some((doc) => hasMatch(changed, doc));
    if (!satisfied) {
      violations.push(`• ${rule.description}`);
    }
  }

  if (violations.length > 0) {
    console.error('❌ Maintenance checklist violations detected:');
    for (const violation of violations) {
      console.error(violation);
    }
    console.error(
      '\nUpdate the referenced documentation files or adjust the change scope before proceeding.'
    );
    process.exit(1);
  }

  console.log('✅ Maintenance checklist satisfied.');
}

main();
