import { FastMCP } from 'fastmcp';
import type { McpConfig } from '../@types/types.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { registerSmartScraperTool } from './smartscraper.js';
import { registerExportTool } from './export.js';
import { registerAgentTools } from './agent.js';
import { registerSearchTool } from './search.js';
import { registerPerformanceTool } from './performance.js';
import { registerFunctionTool } from './function.js';
import { registerMapTool } from './map.js';
import { registerCrawlTool } from './crawl.js';
import { isCompliant } from './compliance.js';
import { registerApiDocsResource } from '../resources/api-docs.js';
import { registerStatusResource } from '../resources/status.js';
import { registerScrapeUrlPrompt } from '../prompts/scrape-url.js';
import { registerExtractContentPrompt } from '../prompts/extract-content.js';

// Registers the advertised MCP surface — tools, resources, and prompts — so the
// compliance gate covers everything a directory reviewer can list, not just
// tools. Compliant mode omits smartscraper/function/map/crawl and their
// smartscraper-specific api-docs resource + scrape-url/extract-content prompts:
// the api-docs resource documents the prohibited proxy/captcha strategies, and
// the prompts instruct the model to call browserless_smartscraper (gated out).
// index.ts and the surface-guard spec both call this, so the test exercises the
// real gating.
// Every registrable surface item carries an explicit `surface` classification —
// there is no positional "unconditional" section a newly added tool could fall
// into and ship on the directory listing by accident. `'both'` = full +
// compliant; `'full'` = full only (dropped from the compliant surface). A new
// entry must state its surface, and the exact-set spec guards the compliant list
// against drift. `browserless_agent`/`browserless_skill` (both `'both'`) reduce
// their OWN shape via isCompliant internally.
type Surface = 'both' | 'full';

export function registerSurface(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  const registrations: ReadonlyArray<{
    surface: Surface;
    register: () => void;
  }> = [
    {
      surface: 'both',
      register: () => registerExportTool(server, config, analytics),
    },
    // agent + skill tools
    {
      surface: 'both',
      register: () => registerAgentTools(server, config, analytics),
    },
    {
      surface: 'both',
      register: () => registerSearchTool(server, config, analytics),
    },
    {
      surface: 'both',
      register: () => registerPerformanceTool(server, config, analytics),
    },
    // Generic service status — safe on both (it reports the active surface).
    { surface: 'both', register: () => registerStatusResource(server, config) },
    // Full-surface only: scraping/code tools, plus the api-docs resource
    // (documents proxy/captcha strategies) and the two prompts (instruct the
    // model to call browserless_smartscraper).
    {
      surface: 'full',
      register: () => registerSmartScraperTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerFunctionTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerMapTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerCrawlTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerApiDocsResource(server, config),
    },
    { surface: 'full', register: () => registerScrapeUrlPrompt(server) },
    { surface: 'full', register: () => registerExtractContentPrompt(server) },
  ];

  const compliant = isCompliant(config);
  for (const { surface, register } of registrations) {
    if (surface === 'both' || !compliant) register();
  }
}
