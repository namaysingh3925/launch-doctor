import type { Finding, Report } from './types.js';

const SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const INFO_URI = 'https://github.com/namaysingh3925/launch-doctor';

interface SarifOptions {
  /**
   * File to point at for findings that have no location (GitHub code scanning needs one per result).
   * Relative to the project root, e.g. "package.json".
   */
  fallbackUri?: string;
}

/**
 * SARIF 2.1.0 output, e.g. for GitHub code scanning.
 * One rule per finding id; one result per finding, with a path relative to the project root.
 */
export function renderSarif(report: Report, opts: SarifOptions = {}): string {
  const findings = report.categories.flatMap((c) => c.findings);

  const rules: object[] = [];
  const ruleIndex = new Map<string, number>();
  for (const f of findings) {
    if (ruleIndex.has(f.id)) continue;
    ruleIndex.set(f.id, rules.length);
    rules.push({
      id: f.id,
      name: f.id,
      shortDescription: { text: f.title },
      fullDescription: { text: f.why },
      help: {
        text: `${f.why}\n\nPrompt to paste into your AI coding tool:\n\n${f.fixPrompt}`,
        markdown: `${f.why}\n\n**Prompt to paste into your AI coding tool:**\n\n\`\`\`text\n${f.fixPrompt}\n\`\`\``,
      },
      defaultConfiguration: { level: level(f) },
      properties: { tags: ['launch-readiness'], precision: 'medium' },
    });
  }

  const results = findings.map((f) => {
    const uri = (f.location?.file ?? opts.fallbackUri ?? 'package.json').replace(/\\/g, '/');
    const region = { startLine: f.location?.line ?? 1 };
    return {
      ruleId: f.id,
      ruleIndex: ruleIndex.get(f.id),
      level: level(f),
      message: { text: f.title },
      locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' }, region } }],
    };
  });

  const sarif = {
    $schema: SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'Launch Doctor', version: report.version, informationUri: INFO_URI, rules } },
        results,
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

function level(f: Finding): 'error' | 'warning' {
  return f.severity === 'critical' ? 'error' : 'warning';
}
