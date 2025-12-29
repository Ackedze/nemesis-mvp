import type { LibraryComponent } from '../reference/library';
import type { DiffEntry } from '../structure/diff';

export type RelevanceStatus = 'deprecated' | 'update' | 'current' | 'unknown';
export type ThemeStatus = 'ok' | 'error';

export interface PathSegment {
  id: string;
  label: string;
  nodeType: BaseNode['type'];
  visible: boolean;
}

export interface AuditItem {
  id: string;
  name: string;
  nodeType: SceneNode['type'];
  pageName: string;
  pathSegments: PathSegment[];
  fullPath: string;
  visible: boolean;
  relevance: RelevanceStatus;
  themeStatus: ThemeStatus;
  librarySource: string | null;
  isLocal: boolean;
  hasDiff: boolean;
  reference?: LibraryComponent | null;
  componentKey: string | null;
  diffs: DiffEntry[];
  comparisonIssues?: string[];
  themeRecommendation?: string | null;
  hasCustomStyle: boolean;
  customStyleReasons?: string[];
}

export interface DetachedEntry {
  id: string;
  name: string;
  pageName: string;
  path: string;
  componentKey: string;
  libraryName: string | null;
  componentName: string | null;
  visible: boolean;
}

export interface TextNodeEntry {
  key: string;
  name: string;
  pageName: string;
  colorLabel: string;
  value: string;
  visible: boolean;
  usesToken: boolean;
  tokenLibrary?: string;
  nodeType?: SceneNode['type'];
  usesStyle: boolean;
}

export interface CustomStyleEntry {
  id: string;
  name: string;
  nodeType: SceneNode['type'] | null;
  pageName: string;
  visible: boolean;
  reason: string;
}
