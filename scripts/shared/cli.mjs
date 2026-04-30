// scripts/shared/cli.mjs

/**
 * parseArgs(argv, schema, options) → config object
 *
 * schema maps flag strings to descriptors:
 *   { type: 'flag',      key: 'dryRun' }          → config.dryRun = true
 *   { type: 'value',     key: 'profileName' }      → config.profileName = next argv token
 *   { type: 'int-value', key: 'limit' }            → config.limit = parseInt(next token)
 *   { type: 'platform',  include: 'zillow' }       → config.selectedPlatforms.add('zillow')
 *   { type: 'platform',  exclude: 'zillow' }       → config.excludedPlatforms.add('zillow')
 *
 * options:
 *   defaults         Object of default values merged into config before parsing.
 *   allowPositional  If true, non-flag tokens are pushed onto config[positionalKey].
 *   positionalKey    Key name for positional args array (default: 'files').
 *
 * Always sets config.help = true when --help or -h is present.
 * Always initialises config.selectedPlatforms and config.excludedPlatforms as Sets.
 */
export function parseArgs(argv, schema, { defaults = {}, allowPositional = false, positionalKey = 'files' } = {}) {
  const config = {
    help: false,
    selectedPlatforms: new Set(),
    excludedPlatforms: new Set(),
    ...defaults,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    const desc = schema[arg];

    if (!desc) {
      if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
      if (!allowPositional) throw new Error(`Unexpected argument: ${arg}. Run with --help for usage.`);
      (config[positionalKey] ??= []).push(arg);
      continue;
    }

    if (desc.type === 'flag') {
      config[desc.key] = true;
    } else if (desc.type === 'value') {
      config[desc.key] = argv[i + 1] ?? '';
      i += 1;
    } else if (desc.type === 'int-value') {
      const val = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isNaN(val) || val < 0) throw new Error(`Expected a non-negative integer after ${arg}.`);
      config[desc.key] = val;
      i += 1;
    } else if (desc.type === 'platform') {
      if (desc.include) config.selectedPlatforms.add(desc.include);
      if (desc.exclude) config.excludedPlatforms.add(desc.exclude);
    }
  }

  return config;
}

export function printHelp(helpText) {
  console.log(helpText);
}
