import { FastMCP } from 'fastmcp';
import type { McpConfig } from '../@types/types.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { registerSmartScraperTool } from './smartscraper.js';
import { registerExportTool } from './export.js';
import { registerReadPageTool } from './read-page.js';
import { registerAgentTools } from './agent.js';
import { registerSearchTool } from './search.js';
import { registerPerformanceTool } from './performance.js';
import { registerFunctionTool } from './function.js';
import { registerMapTool } from './map.js';
import { registerCrawlTool } from './crawl.js';
import { registerProfilesTool } from './profiles.js';
import { registerLiveURLTool } from './live-url.js';
import { registerAccountTool } from './account.js';
import { registerUsageTool } from './usage.js';
import { registerSessionsTool } from './sessions.js';
import { registerLogsTool } from './logs.js';
import { registerStripeLinkConnectTool } from './link-connect.js';
import { registerStripeLinkCheckoutTool } from './link-checkout.js';
import { isCompliant } from './compliance.js';
import { registerApiDocsResource } from '../resources/api-docs.js';
import { registerStatusResource } from '../resources/status.js';
import { registerScrapeUrlPrompt } from '../prompts/scrape-url.js';
import { registerExtractContentPrompt } from '../prompts/extract-content.js';
import { registerStageFileTool } from './stage-file.js';

// Registers the whole surface (tools/resources/prompts) so the compliance gate
// covers all a reviewer lists. Each item declares 'both'|'full'|'compliant' — no positional
// "unconditional" block a new tool could ship on the directory by accident.
type Surface = 'both' | 'full' | 'compliant';

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
      surface: 'full',
      register: () => {
        if (config.transport === 'httpStream')
          registerStageFileTool(server, config, analytics);
      },
    },
    {
      surface: 'both',
      register: () => registerExportTool(server, config, analytics),
    },
    {
      surface: 'compliant',
      register: () => registerReadPageTool(server, config, analytics),
    },
    // agent + skill tools
    {
      surface: 'full',
      register: () => registerAgentTools(server, config, analytics),
    },
    {
      surface: 'both',
      register: () => registerPerformanceTool(server, config, analytics),
    },
    // Full only: account reads show plans, usage and session/request IDs,
    // which directory rules exclude.
    {
      surface: 'full',
      register: () => registerAccountTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerUsageTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerSessionsTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerLogsTool(server, config, analytics),
    },
    // The connector exposes tools only, with no status resource.
    { surface: 'full', register: () => registerStatusResource(server, config) },
    // Full only: scraping/code tools + the api-docs resource and scrape prompts
    // (they document proxy/captcha and steer the model to smartscraper).
    {
      surface: 'full',
      register: () => registerSmartScraperTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerFunctionTool(server, config, analytics),
    },
    // Both: the connector schema caps limit at 500.
    {
      surface: 'both',
      register: () => registerMapTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerCrawlTool(server, config, analytics),
    },
    // Live URL lifecycle is available on the full surface only.
    {
      surface: 'full',
      register: () => registerLiveURLTool(server, config, analytics),
    },
    // Full-only: the compliant surface has no profile capability (agent rejects `profile`).
    {
      surface: 'full',
      register: () => registerProfilesTool(server, config, analytics),
    },
    // Web search is available on both surfaces.
    {
      surface: 'both',
      register: () => registerSearchTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerStripeLinkConnectTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerStripeLinkCheckoutTool(server, config, analytics),
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
    if (surface === 'both' || surface === (compliant ? 'compliant' : 'full'))
      register();
  }
}
