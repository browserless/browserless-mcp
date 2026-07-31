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
import { MCP_SURFACE_REGISTRY, type McpSurfaceId } from '../setup-contract.js';

export function registerSurface(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  const registrations: Record<McpSurfaceId, () => void> = {
    browserless_export: () => registerExportTool(server, config, analytics),
    browserless_agent: () => registerAgentTools(server, config, analytics),
    browserless_skill: () => {}, // registered together with browserless_agent
    browserless_search: () => registerSearchTool(server, config, analytics),
    browserless_performance: () =>
      registerPerformanceTool(server, config, analytics),
    'browserless://status': () => registerStatusResource(server, config),
    browserless_smartscraper: () =>
      registerSmartScraperTool(server, config, analytics),
    browserless_function: () => registerFunctionTool(server, config, analytics),
    browserless_map: () => registerMapTool(server, config, analytics),
    browserless_crawl: () => registerCrawlTool(server, config, analytics),
    browserless_profiles: () => registerProfilesTool(server, config, analytics),
    'browserless://api-docs': () => registerApiDocsResource(server, config),
    'scrape-url': () => registerScrapeUrlPrompt(server),
    'extract-content': () => registerExtractContentPrompt(server),
  };

  const compliant = isCompliant(config);
  for (const { id, surface } of MCP_SURFACE_REGISTRY) {
    if (surface === 'both' || !compliant) registrations[id]();
  }
}
