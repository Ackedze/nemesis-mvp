const STORAGE_KEY = `componentKeyCache_${figma.fileKey}`;

export async function initCache(): Promise<Map<string, string>> {
    try {
        const storedCache = await figma.clientStorage.getAsync(STORAGE_KEY);

        return new Map(storedCache || []);
    } catch (error) {
        console.warn('Не удалось загрузить кэш из хранилища:', error);
        return new Map();
    }
}


export async function getComponentKeyWithCache(instanceNode: InstanceNode, cache: Map<string, string>) {
    if (instanceNode.type !== 'INSTANCE') return null;

    const { id } = instanceNode;

    if (cache.has(id)) {
        return cache.get(id) ?? null;
    }

    try {
        const mainComponent = await instanceNode.getMainComponentAsync();
        const componentKey = mainComponent ? mainComponent.key : null;

        if (componentKey) {
            cache.set(id, componentKey);
        }

        return componentKey;
    } catch (error) {
        console.error('Ошибка получения главного компонента:', error);
        return null;
    }
}

export async function saveCacheToStorage(cache: Map<string, string>) {
    try {
        await figma.clientStorage.setAsync(STORAGE_KEY, Array.from(cache.entries()))
    } catch (error) {
        console.warn('Не удалось сохранить кеш: ', error)
    }
}