/**
 * dsh-tool-modpack — 模组配置覆盖生成器。
 *
 * 支持四种目标格式：JSON / TOML / PROPERTIES / SNBT。
 * 对已存在的文件默认做"深合并"（对象逐层合并，数组整体替换），并先备份原文件，
 * 因此反复调用是幂等的，不会把用户的既有配置冲掉。
 *
 * @module dsh-tool-modpack/config-gen
 */
import { basename, dirname, join } from 'node:path';
import { snbtLiteral } from './quest-gen.js';
import { ModpackError, asRecord, ensureDir, nowIso, pathExists, readJsonSafe, readTextSafe, writeFileEnsured, } from './util.js';
/** 路径白名单：允许写配置的顶层目录。 */
export const CONFIG_PATH_WHITELIST = [
    'config',
    'defaultconfigs',
    'local',
    'options.txt',
    'server.properties',
    'packmenu',
    'polytone',
];
function assertConfigPath(relPath) {
    const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized === '' || normalized.includes('..') || normalized.startsWith('/')) {
        throw new ModpackError('INVALID_PATH', `非法配置路径：${relPath}`);
    }
    const top = normalized.includes('/') ? normalized.slice(0, normalized.indexOf('/')) : normalized;
    if (!CONFIG_PATH_WHITELIST.includes(top)) {
        throw new ModpackError('INVALID_PATH', `配置只能写到 ${CONFIG_PATH_WHITELIST.join(' / ')} 之下，收到：${relPath}`);
    }
    return normalized;
}
// ── 渲染 ─────────────────────────────────────────────────────────────────────
function tomlKey(key) {
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}
function tomlValue(value) {
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number')
        return Number.isFinite(value) ? String(value) : '0';
    if (value === null || value === undefined)
        return '""';
    if (Array.isArray(value))
        return `[${value.map(tomlValue).join(', ')}]`;
    return JSON.stringify(value);
}
/** 渲染 TOML 文本（对象 → [table]，标量在前、子表在后，保证可解析）。 */
export function renderToml(value, path = []) {
    const lines = [];
    const scalars = [];
    const tables = [];
    for (const [key, item] of Object.entries(value)) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            tables.push([key, item]);
        }
        else {
            scalars.push([key, item]);
        }
    }
    if (path.length > 0)
        lines.push(`[${path.map(tomlKey).join('.')}]`);
    for (const [key, item] of scalars)
        lines.push(`${tomlKey(key)} = ${tomlValue(item)}`);
    for (const [key, item] of tables) {
        const body = renderToml(item, [...path, key]);
        if (body.trim() !== '') {
            if (lines.length > 0 && lines[lines.length - 1] !== '')
                lines.push('');
            lines.push(body.replace(/\n+$/, ''));
        }
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
/** 渲染 PROPERTIES 文本（嵌套对象用点号平铺）。 */
export function renderProperties(value, prefix = '') {
    const lines = [];
    for (const [key, item] of Object.entries(value)) {
        const full = prefix === '' ? key : `${prefix}.${key}`;
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            lines.push(renderProperties(item, full).replace(/\n$/, ''));
        }
        else if (Array.isArray(item)) {
            lines.push(`${full}=${item.join(',')}`);
        }
        else {
            lines.push(`${full}=${item === null || item === undefined ? '' : String(item)}`);
        }
    }
    return `${lines.filter((line) => line !== '').join('\n')}\n`;
}
/** 解析简单的 a=b 文本（供合并用）。 */
export function parseProperties(text) {
    const out = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#') || line.startsWith('!'))
            continue;
        const index = line.indexOf('=');
        if (index <= 0)
            continue;
        out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return out;
}
/** 渲染某种格式的配置文本。 */
export function renderConfig(format, content) {
    if (typeof content === 'string')
        return content.endsWith('\n') ? content : `${content}\n`;
    switch (format) {
        case 'json':
            return `${JSON.stringify(content, null, 2)}\n`;
        case 'toml':
            return renderToml(content);
        case 'properties':
            return renderProperties(content);
        case 'snbt':
            return `${snbtLiteral(content)}\n`;
        default:
            throw new ModpackError('UNSUPPORTED_FORMAT', `不支持的配置格式：${String(format)}`);
    }
}
/** 深合并：对象递归合并，数组与非对象整体替换。 */
export function deepMergeObject(base, patch) {
    const left = asRecord(base);
    const right = asRecord(patch);
    const out = { ...left };
    for (const [key, value] of Object.entries(right)) {
        const existing = left[key];
        if (existing !== null &&
            typeof existing === 'object' &&
            !Array.isArray(existing) &&
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value)) {
            out[key] = deepMergeObject(existing, value);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
// ── 写入 ─────────────────────────────────────────────────────────────────────
/** 写一个配置文件（可选深合并 + 备份）。 */
export async function writeConfigFile(packDir, spec) {
    const relPath = assertConfigPath(spec.path);
    const absolutePath = join(packDir, relPath);
    const merge = spec.merge !== false;
    const exists = await pathExists(absolutePath);
    let finalContent = spec.content;
    let merged = false;
    if (exists && merge && spec.format === 'json' && typeof spec.content !== 'string') {
        const existing = await readJsonSafe(absolutePath, {});
        if (asRecord(existing) !== undefined && typeof existing === 'object' && existing !== null) {
            finalContent = deepMergeObject(existing, spec.content);
            merged = true;
        }
    }
    else if (exists && merge && spec.format === 'properties') {
        const existingText = await readTextSafe(absolutePath, '');
        if (existingText !== null && existingText.trim() !== '') {
            const flatExisting = parseProperties(existingText);
            const flatPatch = typeof spec.content === 'string' ? parseProperties(spec.content) : flatten(spec.content);
            const mergedFlat = { ...flatExisting, ...flatPatch };
            finalContent = Object.entries(mergedFlat)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n');
            merged = true;
        }
    }
    else if (exists && merge && typeof spec.content === 'string') {
        const existingText = await readTextSafe(absolutePath, '');
        if (existingText !== null && existingText.includes(spec.content.trim())) {
            return {
                path: relPath,
                absolutePath,
                format: spec.format,
                action: 'unchanged',
                bytes: Buffer.byteLength(existingText, 'utf8'),
                backup: null,
                merged: false,
            };
        }
    }
    const text = renderConfig(spec.format, finalContent);
    await ensureDir(dirname(absolutePath));
    let backup = null;
    if (exists) {
        const previous = await readTextSafe(absolutePath, '');
        if (previous !== null) {
            backup = `${absolutePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            await writeFileEnsured(backup, previous);
        }
    }
    const current = await readTextSafe(absolutePath, null);
    if (current === text) {
        return {
            path: relPath,
            absolutePath,
            format: spec.format,
            action: 'unchanged',
            bytes: Buffer.byteLength(text, 'utf8'),
            backup: null,
            merged,
        };
    }
    await writeFileEnsured(absolutePath, text);
    return {
        path: relPath,
        absolutePath,
        format: spec.format,
        action: exists ? 'updated' : 'created',
        bytes: Buffer.byteLength(text, 'utf8'),
        backup,
        merged,
    };
}
function flatten(value, prefix = '') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        const full = prefix === '' ? key : `${prefix}.${key}`;
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            Object.assign(out, flatten(item, full));
        }
        else {
            out[full] = Array.isArray(item) ? item.join(',') : String(item);
        }
    }
    return out;
}
/** 批量写入配置文件。 */
export async function writeConfigFiles(packDir, specs) {
    const results = [];
    for (const spec of specs)
        results.push(await writeConfigFile(packDir, spec));
    return results;
}
const PARTICLES_CODE = { all: '0', decreased: '1', minimal: '2' };
/** 生成 options.txt 文本。 */
export function renderClientOptions(input) {
    const lines = [];
    const push = (key, value) => {
        if (value === undefined)
            return;
        lines.push(`${key}:${typeof value === 'boolean' ? String(value) : value}`);
    };
    push('version', 3955);
    push('lang', input.language ?? 'zh_cn');
    push('guiScale', input.guiScale ?? 3);
    push('renderDistance', input.renderDistance ?? 10);
    push('simulationDistance', input.simulationDistance ?? 8);
    push('maxFps', input.maxFps ?? 144);
    push('fov', input.fov ?? 0.0);
    push('gamma', input.gamma ?? 0.5);
    push('enableVsync', input.enableVsync ?? false);
    push('pauseOnLostFocus', input.pauseOnLostFocus ?? false);
    push('autoJump', input.autoJump ?? false);
    push('particles', PARTICLES_CODE[input.particles ?? 'decreased'] ?? '1');
    push('graphicsMode', input.graphicsMode ?? 1);
    push('soundCategory_master', input.soundCategoryMaster ?? 1.0);
    push('soundCategory_music', input.musicVolume ?? 0.6);
    return `${lines.join('\n')}\n`;
}
/** 生成 server.properties 文本（键名来自原版专用服务器）。 */
export function renderServerProperties(input) {
    const defaults = {
        'level-name': 'world',
        'gamemode': 'survival',
        difficulty: 'normal',
        'allow-cheats': false,
        'max-players': 20,
        'online-mode': true,
        'view-distance': 10,
        'simulation-distance': 8,
        'motd': 'A Minecraft Server',
        'enable-command-block': false,
        'spawn-protection': 16,
        'sync-chunk-writes': false,
    };
    const merged = { ...defaults, ...input };
    return `${Object.entries(merged)
        .map(([key, value]) => `${key}=${value === null || value === undefined ? '' : String(value)}`)
        .join('\n')}\n`;
}
/**
 * 已知模组的配置文件路径表（只给"路径建议"，不伪造内容）。
 * 模型应当按需要往这些路径写覆盖。
 */
export const KNOWN_CONFIG_PATHS = {
    sodium: { path: 'config/sodium-options.json', format: 'json', note: 'Sodium 渲染设置（Fabric/NeoForge 通用）' },
    embeddium: { path: 'config/embeddium-options.json', format: 'json', note: 'Embeddium（Forge 系 Sodium 分支）' },
    iris: { path: 'config/iris.properties', format: 'properties', note: 'Iris 光影加载器' },
    oculus: { path: 'config/oculus.properties', format: 'properties', note: 'Oculus（Forge 系 Iris 分支）' },
    jei: { path: 'config/jei/jei-client.ini', format: 'properties', note: 'JEI 客户端设置（ini 语法，按 properties 近似处理）' },
    rei: { path: 'config/roughlyenoughitems/config.json5', format: 'json', note: 'REI 设置（json5，写 JSON 亦可被读取）' },
    emi: { path: 'config/emi.css', format: 'properties', note: 'EMI 主题（实际为 CSS 片段，谨慎覆盖）' },
    jade: { path: 'config/jade/jade.json', format: 'json', note: 'Jade 信息提示' },
    kubejs: { path: 'kubejs/config/common.properties', format: 'properties', note: 'KubeJS 通用配置' },
    'ftb-quests': { path: 'config/ftbquests/quests/chapters/chapter_1.snbt', format: 'snbt', note: 'FTB Quests 章节（建议用 modpack_gen_quests 生成）' },
    'fancy-menu': { path: 'config/fancymenu/customization/*.txt', format: 'properties', note: 'FancyMenu 自定义文件，路径带通配，需按需指定' },
    packmenu: { path: 'config/packmenu.json', format: 'json', note: 'PackMenu 主菜单配置（Forge，占位符见 ui-pack 说明）' },
    'server-properties': { path: 'server.properties', format: 'properties', note: '服务端核心设置' },
    'options-txt': { path: 'options.txt', format: 'properties', note: '客户端选项（冒号分隔，用 renderClientOptions 生成更稳）' },
};
/**
 * 根据输入规划要写哪些配置文件。
 * 只对"键名可确证"的 options.txt / server.properties 做内容生成，
 * 其余模组配置一律请模型显式给出 content，避免伪造不存在的键。
 */
export function planConfigOverrides(input) {
    const specs = [];
    const suggestions = [];
    const unknownModIds = [];
    const createdAt = nowIso();
    if (input.clientOptions !== undefined) {
        specs.push({ path: 'options.txt', format: 'properties', content: renderClientOptions(input.clientOptions), merge: false });
    }
    if (input.serverProperties !== undefined) {
        specs.push({ path: 'server.properties', format: 'properties', content: renderServerProperties(input.serverProperties), merge: true });
    }
    for (const modId of input.modIds ?? []) {
        const key = modId.trim().toLowerCase();
        const known = KNOWN_CONFIG_PATHS[key];
        if (known === undefined) {
            unknownModIds.push(modId);
            continue;
        }
        suggestions.push({ modId, path: known.path, format: known.format, note: known.note });
    }
    for (const file of input.files ?? [])
        specs.push(file);
    const planNote = specs.length === 0
        ? '没有需要写入的配置文件：请通过 files 显式给出内容，或打开 clientOptions / serverProperties。'
        : `计划写入 ${specs.length} 个配置文件；未知模组 ${unknownModIds.length} 个，已给出建议路径但未生成内容。`;
    return { specs, suggestions, unknownModIds, planNote, createdAt };
}
/** 便捷函数：先生成计划再落盘。 */
export async function applyConfigPlan(plan, packDir) {
    return writeConfigFiles(packDir, plan.specs);
}
/** 读回某个配置文件（用于验证）。 */
export async function readConfigFile(packDir, relPath) {
    return readTextSafe(join(packDir, assertConfigPath(relPath)), null);
}
/** 备份文件命名（对外的可读形式）。 */
export function backupNameFor(file) {
    return `${basename(file)}.bak`;
}
//# sourceMappingURL=config-gen.js.map