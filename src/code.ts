/// <reference types="@figma/plugin-typings" />

import {
  areReferenceCatalogsReady,
  ensureReferenceCatalogsLoaded,
  findComponentByKeyOrName,
  getCorporateCounterpart,
  getStyleCatalogs,
  getTokenCatalogs,
  LibraryComponent,
  primaryCatalog,
  reportMissingReference,
  resolveStructure,
} from './reference/library';
import { snapshotTree, snapshotNormalizedContext } from './structure/snapshot';
import { DiffEntry, diffStructures } from './structure/diff';
import type { DSStructureNode } from './types/structures';
import type { AuditItem, RelevanceStatus, ThemeStatus } from './types/audit';
import { tabDefinitions } from './config/tabs';
import { eyeClosedIcon, eyeOpenIcon } from './icons';
import { buildNodePath, clampColorComponent, extractAliasKey, getPageName } from './utils/nodeHelpers';
import {
  collectCustomStyleEntries,
  collectDetachedEntries,
  collectTextNodesFromSelection,
  computeChangesResults,
  describeCustomStyleReasons,
  filterVisibleEntries,
  TextNodeCollectionOptions,
  type CustomStyleCollectionOptions,
} from './services/auditViewBuilder';

figma.showUI(__html__, { width: 800, height: 860 });
figma.ui.postMessage({
  type: 'icon-assets',
  payload: { visible: eyeOpenIcon, hidden: eyeClosedIcon },
});
// Передаём UI конфигурацию табов из централизованного источника.
figma.ui.postMessage({
  type: 'tab-config',
  payload: tabDefinitions,
});
startCatalogPreload();

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'ping') {
    figma.ui.postMessage({ type: 'pong' });
    return;
  }

  if (msg.type === 'scan-selection') {
    try {
      await runAudit();
    } catch (error) {
      console.error('scan failed', error);
    }
    return;
  }

  if (msg.type === 'cancel-scan') {
    if (scanInProgress) {
      cancelRequested = true;
    }
    return;
  }

  if (msg.type === 'gpt-request') {
    await handleGptRequest(msg.payload);
    return;
  }

  if (msg.type === 'focus-node') {
    focusNode(msg.payload?.id).catch((error) => {
      console.error('Failed to focus node', error);
      figma.notify('Не удалось перейти к слою.');
    });
    return;
  }
};

let scanInProgress = false;
let cancelRequested = false;
let catalogPreloadStarted = false;
let catalogPreloadFinished = false;
const STRICT_COMPARISON = true;

let tokenLabelMap: Map<string, { label: string; library?: string }> | null =
  null;
let tokenColorMap: Map<string, { label: string; library?: string }> | null =
  null;
let tokenLabelLoadPromise: Promise<void> | null = null;
let styleLabelMap: Map<string, { label: string; library?: string }> | null =
  null;
let styleLabelLoadPromise: Promise<void> | null = null;
let gptRequestActive = false;
const LLM_PROXY_ENDPOINT = 'http://localhost:3000/yandex-llm';
const YANDEX_MODEL = 'gpt-4o-mini';

/**
 * Запускает полный аудит выделенной сцены: загружает каталоги, делает снимок,
 * сравнивает со справочником и обрабатывает результат для UI.
 * Функция отслеживает отмену, показывает уведомления и пишет логи по времени.
 */
/**
 * Запускает полный аудит текущего выделения: проверяет готовность справочников,
 * снимает snapshоты, классифицирует узлы и формирует структуры для табов UI.
 */
async function runAudit() {
  if (scanInProgress) {
    figma.notify('Проверка уже выполняется.');
    return;
  }
  scanInProgress = true;
  cancelRequested = false;
  figma.ui.postMessage({ type: 'scan-started' });
  let finished = false;
  const getTimestamp = () =>
    typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
  const auditStart = getTimestamp();
  const finalize = (status: 'finished' | 'cancelled') => {
    if (finished) return;
    finished = true;
    if (status === 'cancelled') {
      figma.ui.postMessage({ type: 'scan-cancelled' });
    } else {
      figma.ui.postMessage({ type: 'scan-finished' });
    }
    scanInProgress = false;
    cancelRequested = false;
    console.log(
      `[Nemesis] audit total: ${(getTimestamp() - auditStart).toFixed(
        1,
      )} ms (${status})`,
    );
  };

  const abortIfNeeded = () => {
    if (cancelRequested) {
      finalize('cancelled');
      return true;
    }
    return false;
  };

  try {
    if (!areReferenceCatalogsReady()) {
      figma.notify('Подключаемся к библиотекам Nemesis…');
    }
    await ensureReferenceCatalogsLoaded();
    await ensureTokenLabelMapLoaded();
    await ensureStyleLabelMapLoaded();
  } catch (error) {
    console.error('Failed to load reference catalogs', error);
    const message =
      'Не удалось загрузить данные библиотеки. Проверьте интернет-соединение и попробуйте ещё раз.';
    figma.notify(message);
    figma.ui.postMessage({ type: 'scan-error', payload: { message } });
    finalize('finished');
    return;
  }

  try {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      const message = 'Выделите область или слой, чтобы проверить компоненты.';
      figma.notify(message);
      figma.ui.postMessage({ type: 'scan-error', payload: { message } });
      finalize('finished');
      return;
    }

    const normalizedSnapshots = [];
    for (const node of selection) {
      try {
        const normalized = await snapshotNormalizedContext(node);
        console.log('[Nemesis] normalized snapshot', normalized);
        normalizedSnapshots.push(normalized);
      } catch (error) {
        console.warn('[Nemesis] normalized snapshot failed', error);
      }
    }
    figma.ui.postMessage({
      type: 'normalized-snapshot-ready',
      payload: normalizedSnapshots.length ? normalizedSnapshots : null,
    });

    const targets = collectTargets(selection);
    if (targets.length === 0) {
      const message = 'Компоненты или инстансы в выделении не найдены.';
      figma.notify(message);
      figma.ui.postMessage({ type: 'scan-error', payload: { message } });
    }

    const relevanceBuckets: Record<RelevanceStatus, AuditItem[]> = {
      deprecated: [],
      update: [],
      current: [],
      unknown: [],
    };
    const themeBuckets: Record<ThemeStatus, AuditItem[]> = {
      ok: [],
      error: [],
    };
    const localLibraryItems: AuditItem[] = [];
    const presetItems: AuditItem[] = [];
    const referenceStructureCache = new Map<string, DSStructureNode[] | null>();
    const classificationBatchSize = 4;
    const customStyleEntries = collectCustomStyleEntries(selection, {
      tokenLabelMap: tokenLabelMap ?? new Map(),
    });
    const customStyleReasonOptions: CustomStyleCollectionOptions = {
      tokenLabelMap: tokenLabelMap ?? new Map(),
    };

    for (
      let offset = 0;
      offset < targets.length;
      offset += classificationBatchSize
    ) {
      if (abortIfNeeded()) {
        return;
      }
      const batch = targets.slice(offset, offset + classificationBatchSize);
      const items = await Promise.all(
        batch.map((node) =>
          classifyNode(node, referenceStructureCache, customStyleReasonOptions),
        ),
      );
      for (const item of items) {
        if (abortIfNeeded()) {
          return;
        }
        relevanceBuckets[item.relevance].push(item);
        themeBuckets[item.themeStatus].push(item);
        if (item.isLocal) {
          localLibraryItems.push(item);
        }
        if (isPresetCandidate(item)) {
          presetItems.push(item);
        }
      }
    }

    if (abortIfNeeded()) {
      return;
    }

    const textNodeOptions: TextNodeCollectionOptions = {
      tokenLabelMap: tokenLabelMap ?? new Map(),
      tokenColorMap: tokenColorMap ?? new Map(),
    };
    const allTextNodes = collectTextNodesFromSelection(selection, textNodeOptions);
    const missingTokenTextNodes = allTextNodes.filter(
      (entry) => !entry.usesToken && !entry.usesStyle,
    );
    const detachedEntries = collectDetachedEntries(selection);
    const counts = {
      current: relevanceBuckets.current.length,
      deprecated: relevanceBuckets.deprecated.length,
      update: relevanceBuckets.update.length,
      themeError: themeBuckets.error.length,
      local: localLibraryItems.length,
      textNodes: missingTokenTextNodes.length,
      textAll: allTextNodes.length,
      detached: detachedEntries.length,
      changes: 0,
    };
    const changesResults = computeChangesResults(relevanceBuckets.current, {
      visibleOnly: false,
    });
    const visibleChangesResults = computeChangesResults(
      relevanceBuckets.current,
      { visibleOnly: true },
    );
    counts.changes = changesResults.length;

    const visibleViews = {
      relevance: {
        current: filterVisibleEntries(relevanceBuckets.current),
        deprecated: filterVisibleEntries(relevanceBuckets.deprecated),
        update: filterVisibleEntries(relevanceBuckets.update),
        unknown: filterVisibleEntries(relevanceBuckets.unknown),
      },
      theme: {
        ok: filterVisibleEntries(themeBuckets.ok),
        error: filterVisibleEntries(themeBuckets.error),
      },
      local: filterVisibleEntries(localLibraryItems),
      textNodes: filterVisibleEntries(missingTokenTextNodes),
      textAll: filterVisibleEntries(allTextNodes),
      customStyles: filterVisibleEntries(customStyleEntries),
      detached: filterVisibleEntries(detachedEntries),
      presets: filterVisibleEntries(presetItems),
      changes: visibleChangesResults,
    };

    figma.ui.postMessage({
      type: 'scan-result',
      payload: {
        detached: detachedEntries,
        counts,
        summary: {
          totalTargets: targets.length,
          selectionRoots: selection.length,
          selectionNames: selection.map((node) => node.name),
          catalogName: primaryCatalog.name,
        },
        views: {
          relevance: relevanceBuckets,
          theme: themeBuckets,
          local: localLibraryItems,
          textNodes: missingTokenTextNodes,
          textAll: allTextNodes,
          customStyles: customStyleEntries,
          detached: detachedEntries,
          presets: presetItems,
        },
        visibleViews,
        changes: changesResults,
      },
    });

    finalize('finished');
  } catch (error) {
    console.error('Unhandled error during audit', error);
    const message = 'Не удалось завершить проверку. Подробности в консоли.';
    figma.notify(message);
    figma.ui.postMessage({ type: 'scan-error', payload: { message } });
    finalize('finished');
  }
}

/**
 * Preload запускается один раз и подготавливает UI, пока каталоги подгружаются в фоне.
 */
function startCatalogPreload() {
  if (catalogPreloadStarted) return;
  catalogPreloadStarted = true;
  figma.ui.postMessage({ type: 'catalog-loading' });
  ensureReferenceCatalogsLoaded()
    .then(() => {
      catalogPreloadFinished = true;
      figma.ui.postMessage({ type: 'catalog-ready' });
    })
    .catch((error) => {
      console.error('Catalog preload failed', error);
      const message =
        'Не удалось загрузить библиотеки. Проверьте подключение и попробуйте снова.';
      figma.ui.postMessage({ type: 'catalog-error', payload: { message } });
    });
}

/**
 * Рекурсивно собирает все компоненты и инстансы внутри выделения (кроме обычных фреймов),
 * чтобы мы могли прогнать их по справочнику.
 */
function collectTargets(selection: readonly SceneNode[]): SceneNode[] {
  const result: SceneNode[] = [];
  const visit = (node: SceneNode) => {
    if (node.type === 'INSTANCE' || node.type === 'COMPONENT') {
      result.push(node);
    }

    if ('children' in node) {
      for (const child of node.children as SceneNode[]) {
        visit(child);
      }
    }
  };

  for (const node of selection) {
    visit(node as SceneNode);
  }

  return result;
}

/**
 * Приводит SceneNode к `AuditItem`: ищет компонент в каталогах, делает снапшот,
 * сравнивает структуру и собирает diff-последствия, статус темы и причины кастомизации.
 */
/**
 * Приводит SceneNode к AuditItem: ищет компонент, подготавливает referenceStructure,
 * снимает snapshot, делает diff и собирает диагностические метаданные.
 */
async function classifyNode(
  node: SceneNode,
  referenceStructureCache: Map<string, DSStructureNode[] | null>,
  customStyleOptions: CustomStyleCollectionOptions,
): Promise<AuditItem> {
  const componentKey = await getComponentKey(node);
  // instance key logging removed
  const ref = findComponentByKeyOrName(componentKey, node.name);
  const comparisonIssues: string[] = [];
  if (!ref && componentKey) {
    reportMissingReference(componentKey, node.name);
  }
  let referenceStructure = getReferenceStructureCached(
    ref,
    componentKey,
    referenceStructureCache,
  );
  if (ref && componentKey && Array.isArray(ref.variants) && ref.variants.length) {
    const variant = ref.variants.find((item) => item?.key === componentKey);
    if (!variant) {
      comparisonIssues.push(
        `Вариант ${componentKey} не найден в каталоге для «${ref.name ?? node.name}»`,
      );
      referenceStructure = null;
    } else if (!ref.variantStructures || !ref.variantStructures[componentKey]) {
      comparisonIssues.push(
        `Нет variantStructures для «${variant.name ?? componentKey}» (${ref.name ?? node.name})`,
      );
      referenceStructure = null;
    }
  }
  const needsDiff = Boolean(referenceStructure);
  const instanceHasOverrides =
    node.type === 'INSTANCE' && hasInstanceOverrides(node as InstanceNode);
  const shouldDiff =
    needsDiff && (ref?.status !== 'current' || instanceHasOverrides);
  const actualStructure =
    shouldDiff && referenceStructure ? await snapshotTree(node) : null;
  const alignedActualStructure =
    referenceStructure && actualStructure
      ? alignStructurePaths(actualStructure, referenceStructure)
      : actualStructure;
  const diffResult =
    shouldDiff && referenceStructure && alignedActualStructure
      ? diffStructures(alignedActualStructure, referenceStructure, {
          strict: STRICT_COMPARISON,
          resolveTokenLabel: resolveTokenLabelForDiff,
          resolveColorLabel: resolveTokenLabelFromColor,
          resolveStyleLabel: resolveStyleLabelForDiff,
        })
      : { diffs: [], issues: [] };
  if (diffResult.issues.length) {
    comparisonIssues.push(...diffResult.issues);
  }
  const diffs = diffResult.diffs;
  if (comparisonIssues.length) {
    console.warn('[Nemesis] comparison issues', {
      nodeId: node.id,
      name: node.name,
      issues: comparisonIssues.slice(0, 8),
      issuesText: comparisonIssues.slice(0, 8).join(' | '),
      total: comparisonIssues.length,
    });
  }

  const isLocal = !ref;
  const relevance = normalizeRelevanceStatus(ref?.status);

  const pageName = getPageName(node);
  const fullPath = buildNodePath(node);

  const themeMismatch = detectThemeMismatch(node, ref);
  const themeStatus: ThemeStatus = themeMismatch ? 'error' : 'ok';
  if (themeMismatch) {
    diffs.unshift({
      message: themeMismatch.message,
      nodeId: node.id,
      nodeName: node.name,
      nodePath: fullPath || node.name,
    });
  }

  const hasDiff = diffs.length > 0;
  const nodeSegments = buildNodeSegments(node);
  const pathSegments =
    nodeSegments.length > 1
      ? nodeSegments.slice(1)
      : nodeSegments.length
        ? nodeSegments
        : [{ id: node.id, label: node.name }];
  const customStyleReasons = describeCustomStyleReasons(
    node,
    customStyleOptions,
  );
  const hasCustomStyle = customStyleReasons.length > 0;

  return {
    id: node.id,
    name: node.name,
    nodeType: node.type,
    pageName,
    pathSegments,
    fullPath,
    visible: 'visible' in node ? (node as any).visible !== false : true,
    relevance,
    themeStatus,
    librarySource: ref?.source ?? null,
    isLocal,
    hasDiff,
    reference: ref,
    componentKey,
    diffs,
    comparisonIssues: comparisonIssues.length ? comparisonIssues : undefined,
    themeRecommendation: themeMismatch?.replacementName ?? null,
    hasCustomStyle,
    customStyleReasons,
  };
}

async function getComponentKey(node: SceneNode): Promise<string | null> {
  if (node.type === 'INSTANCE') {
    return getInstanceMainComponentKey(node as InstanceNode);
  }
  if (node.type === 'COMPONENT') {
    return node.key ?? null;
  }
  return null;
}

async function getInstanceMainComponentKey(
  inst: InstanceNode,
): Promise<string | null> {
  if (typeof inst.getMainComponentAsync === 'function') {
    const main = await inst.getMainComponentAsync();
    return main?.key ?? null;
  }
  return inst.mainComponent?.key ?? null;
}

/**
 * Проверяет, содержит ли инстанс конкретные переопределения, чтобы
 * не делать diff для чистых текущих компонентов при strict-видимости.
 */
function hasInstanceOverrides(instance: InstanceNode): boolean {
  const overrides = instance.overrides;
  return Array.isArray(overrides) && overrides.length > 0;
}

async function focusNode(nodeId: string | undefined) {
  if (!nodeId) return;
  const node = await findNodeById(nodeId);
  if (!node || node.type === 'DOCUMENT') {
    figma.notify('Не удалось найти слой для перехода');
    return;
  }

  let page: PageNode | null = null;
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === 'PAGE') {
      page = current as PageNode;
      break;
    }
    current = current.parent as BaseNode | null;
  }

  if (!page) {
    figma.notify('Не удалось определить страницу для этого слоя');
    return;
  }

  if (typeof (figma as any).setCurrentPageAsync === 'function') {
    try {
      await (figma as any).setCurrentPageAsync(page);
    } catch (error) {
      console.error('Failed to switch page asynchronously', error);
      figma.notify('Не удалось перейти на страницу слоя');
      return;
    }
  } else {
    figma.currentPage = page;
  }

  try {
    figma.currentPage.selection = [node as SceneNode];
    figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
  } catch (error) {
    console.error('Failed to focus node on page', error);
    figma.notify('Не удалось перейти к слою на этой странице');
  }
}

async function findNodeById(nodeId: string): Promise<BaseNode | null> {
  const getNodeByIdAsync = (figma as any).getNodeByIdAsync;
  if (typeof getNodeByIdAsync === 'function') {
    return (await getNodeByIdAsync(nodeId)) ?? null;
  }
  return figma.getNodeById(nodeId);
}

function getReferenceStructure(
  ref: LibraryComponent | null | undefined,
  variantKey: string | null,
) {
  if (!ref) return null;
  const structure = resolveStructure(ref, variantKey);
  if (structure && structure.length > 0) {
    return structure;
  }
  return null;
}

function getReferenceStructureCached(
  ref: LibraryComponent | null | undefined,
  variantKey: string | null,
  cache: Map<string, DSStructureNode[] | null>,
): DSStructureNode[] | null {
  if (!ref) return null;
  const cacheKey = `${ref.key ?? ref.displayName ?? 'unknown'}:${variantKey ?? 'default'}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }
  const structure = getReferenceStructure(ref, variantKey);
  cache.set(cacheKey, structure);
  return structure;
}

function buildNodeSegments(node: SceneNode): PathSegment[] {
  const segments: PathSegment[] = [];
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    const nodeType = current.type;
    const hasVisibleFlag = 'visible' in current;
    const isVisible = hasVisibleFlag
      ? (current as SceneNode & { visible: boolean }).visible !== false
      : true;
    segments.push({
      id: current.id,
      label: current.name,
      nodeType,
      visible: isVisible,
    });
    current = current.parent as BaseNode | null;
  }
  return segments.reverse();
}

function normalizeRelevanceStatus(
  status: LibraryComponent['status'] | undefined,
): RelevanceStatus {
  switch (status) {
    case 'deprecated':
      return 'deprecated';
    case 'update':
    case 'changed':
      return 'update';
    case 'current':
      return 'current';
    default:
      return 'unknown';
  }
}

function alignStructurePaths(
  actual: DSStructureNode[],
  reference: DSStructureNode[],
): DSStructureNode[] {
  if (actual.length === 0 || reference.length === 0) return actual;
  const actualRoot = actual[0].path;
  const referenceRoot =
    reference.find((node) => !node.path.includes(' / '))?.path ??
    reference[0].path;
  if (!actualRoot || !referenceRoot || actualRoot === referenceRoot) {
    return actual;
  }

  const prefix = actualRoot;
  const newPrefix = referenceRoot;
  return actual.map((node) => {
    const cloned = Object.assign({}, node);
    cloned.path = replacePathPrefix(node.path, prefix, newPrefix);
    return cloned;
  });
}

type ThemeMismatchInfo = {
  message: string;
  replacementName?: string | null;
};

function detectThemeMismatch(
  node: SceneNode,
  ref: LibraryComponent | null | undefined,
): ThemeMismatchInfo | null {
  if (!ref) return null;
  if (ref.role === 'Part') return null;
  const name = ref.name ?? '';
  const pair = getCorporateCounterpart(name);
  if (!pair?.corporate) {
    return null;
  }
  const isCorpComponent = name.includes('[Corporate]');
  if (!isCorpComponent) {
    return {
      message: 'Доступен корпоративный вариант компонента',
      replacementName:
        pair.corporate?.name ??
        pair.corporate?.displayName ??
        `[Corporate] ${pair.base?.name ?? ''}`.trim(),
    };
  }
  return null;
}

function paintUsesToken(paint: Paint): boolean {
  if (!paint || typeof paint !== 'object') return false;
  const info = getTokenAliasInfo(paint as SolidPaint);
  return Boolean(info.aliasKey);
}

function isPresetCandidate(item: AuditItem): boolean {
  if (item.nodeType !== 'INSTANCE') return false;
  if (!item.reference) return false;
  return hasLockSymbol(item.reference);
}

function hasLockSymbol(component: LibraryComponent): boolean {
  if (!component) return false;
  if (component.displayName?.includes('🔒')) {
    return true;
  }
  for (const name of component.names ?? []) {
    if (name.includes('🔒')) {
      return true;
    }
  }
  return false;
}

function replacePathPrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  const needle = `${from} / `;
  if (path.startsWith(needle)) {
    return `${to} / ${path.slice(needle.length)}`;
  }
  return path;
}

/**
 * Строит ассоциативные карты для токенов и цветов по всем загруженным токен-каталогам
 * и сохраняет их в память, чтобы позже подставлять читаемые названия и библиотеку.
 */
async function ensureTokenLabelMapLoaded(): Promise<void> {
  if (tokenLabelMap) return;
  if (tokenLabelLoadPromise) {
    return tokenLabelLoadPromise;
  }
  tokenLabelLoadPromise = (async () => {
    try {
      await ensureReferenceCatalogsLoaded();
      const catalogs = getTokenCatalogs();
      const map = new Map<string, { label: string; library?: string }>();
      const colorMap = new Map<string, { label: string; library?: string }>();
      for (const catalog of catalogs) {
        const catalogLibrary =
          catalog.meta?.library ?? catalog.meta?.fileName ?? '';
        const collections = catalog.collections ?? [];
        for (const collection of collections) {
          if (!collection) continue;
          const collectionName =
            collection.name ?? catalogLibrary ?? catalog.meta?.fileName ?? '';
          const defaultModeId = collection.defaultModeId ?? null;
          const variables = collection.variables ?? [];
          for (const variable of variables) {
            if (!variable || !variable.key) continue;
            const label = buildTokenLabel(
              collectionName,
              variable.groupName ?? 'Без группы',
              variable.tokenName ?? variable.name ?? '',
            );
            map.set(variable.key, {
              label,
              library: collectionName || catalogLibrary,
            });
            if (defaultModeId && variable.valuesByMode) {
              const rgba = toRgbaStringFromToken(
                variable.valuesByMode[defaultModeId],
              );
              if (rgba && !colorMap.has(rgba)) {
                colorMap.set(rgba, {
                  label,
                  library: collectionName || catalogLibrary,
                });
              }
            }
          }
        }
      }
      tokenLabelMap = map;
      tokenColorMap = colorMap;
    } catch (error) {
      console.warn('[Nemesis] failed to load token catalogs', error);
      tokenLabelMap = new Map();
      tokenColorMap = new Map();
    } finally {
      tokenLabelLoadPromise = null;
    }
  })();
  return tokenLabelLoadPromise;
}

/**
 * Подготавливает карту стилей, привязанную к их библиотекам и группам,
 * для доступного отображения ссылок на стили при сравнении.
 */
async function ensureStyleLabelMapLoaded(): Promise<void> {
  if (styleLabelMap) return;
  if (styleLabelLoadPromise) {
    return styleLabelLoadPromise;
  }
  styleLabelLoadPromise = (async () => {
    try {
      await ensureReferenceCatalogsLoaded();
      const catalogs = getStyleCatalogs();
      const map = new Map<string, { label: string; library?: string }>();
      for (const catalog of catalogs) {
        const libraryName =
          catalog.meta?.library || catalog.meta?.fileName || '';
        const styles = catalog.styles ?? [];
        for (const style of styles) {
          if (!style?.key) continue;
          const label = buildStyleLabel(
            libraryName || '',
            style.group ?? '',
            style.name ?? '',
          );
          map.set(style.key, { label, library: libraryName || undefined });
        }
      }
      styleLabelMap = map;
    } catch (error) {
      console.warn('[Nemesis] failed to load style catalogs', error);
      styleLabelMap = new Map();
    } finally {
      styleLabelLoadPromise = null;
    }
  })();
  return styleLabelLoadPromise;
}

function buildTokenLabel(
  collectionName: string,
  groupName: string,
  tokenName: string,
): string {
  const segments: string[] = [];
  if (groupName && groupName !== 'Без группы') {
    segments.push(groupName);
  }
  if (tokenName) {
    segments.push(tokenName);
  }
  return segments.join('/');
}

function buildStyleLabel(
  libraryName: string,
  groupName: string,
  styleName: string,
): string {
  const normalizedStyleName = stripStyleSuffix(styleName);
  const segments: string[] = [];
  if (groupName && groupName !== 'Без группы') {
    segments.push(groupName);
  }
  if (normalizedStyleName) {
    segments.push(normalizedStyleName);
  }
  return segments.join('/');
}

function stripStyleSuffix(value: string): string {
  if (!value) return value;
  const index = value.indexOf(' (');
  if (index === -1) return value;
  return value.slice(0, index).trim();
}

function resolveTokenLabelForDiff(token: string): string | null {
  const aliasKey = extractAliasKey(token);
  if (!aliasKey) return token;
  const label = tokenLabelMap?.get(aliasKey);
  return label?.label ?? token;
}

function resolveStyleLabelForDiff(styleKey: string): string | null {
  const direct = styleLabelMap?.get(styleKey);
  if (direct?.label) return direct.label;
  if (styleKey.startsWith('S:')) {
    const extracted = styleKey.slice(2).split(',')[0];
    if (extracted) {
      const byKey = styleLabelMap?.get(extracted);
      if (byKey?.label) return byKey.label;
    }
  }
  return styleKey;
}

function resolveTokenLabelFromColor(color: string): string | null {
  const normalized = normalizeRgba(color);
  const label = tokenColorMap?.get(normalized);
  return label?.label ?? null;
}

function normalizeRgba(value: string): string {
  return value.replace(/\s+/g, '');
}

function toRgbaStringFromToken(value: any): string | null {
  if (!value || typeof value !== 'object') return null;
  if (
    typeof value.r !== 'number' ||
    typeof value.g !== 'number' ||
    typeof value.b !== 'number'
  ) {
    return null;
  }
  const r = clampColorComponent(value.r);
  const g = clampColorComponent(value.g);
  const b = clampColorComponent(value.b);
  const a = typeof value.a === 'number' ? Math.round(value.a * 100) / 100 : 1;
  return normalizeRgba(`rgba(${r},${g},${b},${a})`);
}

function getTokenAliasInfo(paint: SolidPaint) {
  const boundVariables = paint.boundVariables;
  if (!boundVariables?.color?.id) {
    return { aliasKey: null, label: null, library: null, known: false };
  }
  const aliasKey = extractAliasKey(boundVariables.color.id);
  if (!aliasKey) {
    return { aliasKey: null, label: null, library: null, known: false };
  }
  const label = tokenLabelMap?.get(aliasKey);
  return {
    aliasKey,
    label: label?.label ?? null,
    library: label?.library ?? null,
    known: Boolean(label),
  };
}

function toHex(component: number): string {
  const hex = component.toString(16).toUpperCase();
  return hex.length === 1 ? '0' + hex : hex;
}

async function handleGptRequest(payload?: GptRequestPayload) {
  if (gptRequestActive) {
    figma.ui.postMessage({
      type: 'gpt-error',
      payload: { message: 'Запрос уже выполняется.' },
    });
    return;
  }
  if (!payload?.prompt) {
    figma.ui.postMessage({
      type: 'gpt-error',
      payload: { message: 'Параметры запроса некорректны.' },
    });
    return;
  }
  gptRequestActive = true;
  try {
    const response = await fetch(LLM_PROXY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: payload.prompt,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Сервер вернул ${response.status}: ${body.substring(0, 150)}`,
      );
    }
    const data = await response.json();
    const alternative = data?.result?.alternatives?.[0];
    const textFromMessage = alternative?.message?.text;
    const textFromContent =
      Array.isArray(alternative?.content) &&
      alternative.content
        .map(
          (segment) =>
            (segment && typeof segment.text === 'string' && segment.text) ||
            '',
        )
        .join('')
        .trim();
    const textFromChoices =
      data?.choices?.[0]?.message?.content?.trim?.();
    const textFromDirect =
      typeof data?.text === 'string' ? data.text.trim() : null;
    const resultValue =
      textFromMessage ||
      textFromDirect ||
      textFromContent ||
      textFromChoices ||
      'Ответ отсутствует.';
    console.log('nemesis gpt response', {
      result: resultValue,
      alternative,
      raw: data,
      prompt: payload.prompt,
      reqId: data?.requestId ?? data?.reqId ?? null,
    });
    figma.ui.postMessage({
      type: 'gpt-response',
      payload: { text: resultValue },
    });
  } catch (error) {
    console.error('Yandex Cloud AI request failed', error);
    figma.ui.postMessage({
      type: 'gpt-error',
      payload: {
        message:
          error instanceof Error
            ? error.message
            : 'Не удалось получить ответ от Yandex Cloud AI.',
      },
    });
  } finally {
    gptRequestActive = false;
  }
}
