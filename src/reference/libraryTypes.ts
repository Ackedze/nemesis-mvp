import type {
  DSStructureNode,
  DSVariantStructurePatch,
} from '../types/structures';

export type LibraryStatus = 'deprecated' | 'update' | 'current' | 'changed';
export type ComponentPlatform = 'Desktop' | 'Mobile Web' | 'Universal';
export type ComponentRole = 'Main' | 'Part';

export interface LibraryComponent {
  key?: string;
  names: string[];
  status: LibraryStatus;
  platform?: ComponentPlatform;
  role?: ComponentRole;
  source?: string;
  displayName: string;
  variantOf?: string;
  parentComponent?: { key: string | null; name: string | null } | null;
  structure?: DSStructureNode[];
  variantStructures?: Record<string, DSVariantStructurePatch[]>;
  notes?: string;
}

export interface LibraryCatalog {
  id: string;
  name: string;
  components: LibraryComponent[];
}

export interface AthenaVariant {
  key: string;
  name: string;
  id: string;
  properties?: Record<string, string>;
}

export interface AthenaComponent {
  key: string;
  name: string;
  description?: string;
  status?: string;
  role?: string;
  platform?: string;
  variants?: AthenaVariant[];
  structure?: DSStructureNode[];
  variantStructures?: Record<string, DSVariantStructurePatch[]>;
  parentComponent?: { key: string | null; name: string | null } | null;
  meta?: {
    pageName: string;
    category: string | null;
  };
}

export interface AthenaCatalog {
  meta: {
    fileName: string;
    library?: string;
  };
  components: AthenaComponent[];
}
