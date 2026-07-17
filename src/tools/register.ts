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
import { registerProfilesTool } from './profiles.js';
import { isCompliant } from './compliance.js';
import { registerApiDocsResource } from '../resources/api-docs.js';
import { registerStatusResource } from '../resources/status.js';
import { registerScrapeUrlPrompt } from '../prompts/scrape-url.js';
import { registerExtractContentPrompt } from '../prompts/extract-content.js';

// Registers the whole surface (tools/resources/prompts) so the compliance gate
// covers all a reviewer lists. Each item declares 'both'|'full' — no positional
// "unconditional" block a new tool could ship on the directory by accident.
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
    {
      surface: 'full',
      register: () => registerMapTool(server, config, analytics),
    },
    {
      surface: 'full',
      register: () => registerCrawlTool(server, config, analytics),
    },
    // Auth-profile listing is full-only: the compliant surface exposes no profile
    // capability (the agent rejects `profile`), so it must not advertise profiles.
    {
      surface: 'full',
      register: () => registerProfilesTool(server, config, analytics),
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
