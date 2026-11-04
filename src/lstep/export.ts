import type {
  SourceAutoReply, SourceField, SourceFormDetail, SourceFormResponse, SourceFriendSnapshot,
  SourceHandlingStatus, SourceRichMenu, SourceScenarioDetail, SourceTag, SourceTemplateDetail,
  SourceTrafficSource, SourceWelcomeMessage,
} from "../source/types.js";

export type CoverageStatus = "complete" | "partial" | "unsupported" | "failed";
export interface ResourceCoverage {
  status: CoverageStatus;
  count: number;
  note?: string;
}

export interface SourceExport {
  schemaVersion: 1;
  platform: "lstep";
  route: "api" | "browser" | "hybrid";
  account: { id: string; label?: string };
  exportedAt: string;
  idMappings?: {
    formFields: Record<string, number>;
    formSections: Record<string, number>;
  };
  resources: {
    friends: SourceFriendSnapshot[];
    tags: SourceTag[];
    fields: SourceField[];
    handlingStatuses: SourceHandlingStatus[];
    scenarios: SourceScenarioDetail[];
    templates: SourceTemplateDetail[];
    forms: SourceFormDetail[];
    formResponses: Record<string, SourceFormResponse[]>;
    autoReplies: SourceAutoReply[];
    welcomeMessages: SourceWelcomeMessage[];
    richMenus: SourceRichMenu[];
    trafficSources: SourceTrafficSource[];
  };
  coverage: Record<string, ResourceCoverage>;
}

export function emptyExport(route: SourceExport["route"], accountId: string): SourceExport {
  return {
    schemaVersion: 1, platform: "lstep", route,
    account: { id: accountId }, exportedAt: new Date().toISOString(),
    resources: {
      friends: [], tags: [], fields: [], handlingStatuses: [], scenarios: [],
      templates: [], forms: [], formResponses: {}, autoReplies: [],
      welcomeMessages: [], richMenus: [], trafficSources: [],
    },
    coverage: {},
  };
}
