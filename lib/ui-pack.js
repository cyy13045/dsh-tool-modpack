/**
 * dsh-tool-modpack — 界面材质包组装器。
 *
 * 把 AI 生成的纹理、PackMenu 按钮定义、Polytone GUI 修饰符、Vistas 全景清单、
 * pack.mcmeta 组装成一个可直接放进 resourcepacks/ 的资源包（目录或 zip）。
 *
 * 资源包内部路径（写入前逐条校验，路径不对资源包不会生效）：
 *   assets/<ns>/textures/gui/title/background/panorama_0.png … panorama_5.png
 *   assets/<ns>/textures/gui/title/background/panorama_overlay.png
 *   assets/<ns>/textures/gui/sprites/{widget,icon,hud,container,tooltip}/…
 *   assets/<ns>/textures/gui/widgets.png / icons.png
 *   assets/<ns>/buttons/<name>.json            ← PackMenu（SimpleJsonResourceReloadListener("buttons")）
 *   assets/<ns>/polytone/gui_modifiers/<n>.json ← Polytone
 *   assets/<ns>/panoramas.json                  ← Vistas
 *   assets/<ns>/lang/<locale>.json
 *   pack.mcmeta
 *
 * 另外：PackMenu 自身的内置包位于 <gamedir>/packmenu/resources/（folder pack），
 * 因此当 alsoWritePackMenuFolder=true 时，按钮 JSON 与全景图会同时同步到 packmenu/resources/。
 *
 * @module dsh-tool-modpack/ui-pack
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePng, solidPng } from './image-gen.js';
import { buildZip, writeZip } from './packer.js';
import { ModpackError, assetPath, clampInt, ensureDir, hexToRgbInt, normalizeHex, nowIso, pathExists, slugify, writeFileEnsured, } from './util.js';
/**
 * 资源包 pack_format 对照表（原版 ResourcePackFormat 常量）。
 * 表只覆盖到 1.21.8；更新的版本回落到最新的已知值并给出警告。
 */
export const PACK_FORMAT_TABLE = [
    { from: '1.6.1', to: '1.8.9', format: 1 },
    { from: '1.9', to: '1.10.2', format: 2 },
    { from: '1.11', to: '1.12.2', format: 3 },
    { from: '1.13', to: '1.14.4', format: 4 },
    { from: '1.15', to: '1.16.1', format: 5 },
    { from: '1.16.2', to: '1.16.5', format: 6 },
    { from: '1.17', to: '1.17.1', format: 7 },
    { from: '1.18', to: '1.18.2', format: 8 },
    { from: '1.19', to: '1.19.2', format: 9 },
    { from: '1.19.3', to: '1.19.3', format: 12 },
    { from: '1.19.4', to: '1.19.4', format: 13 },
    { from: '1.20', to: '1.20.1', format: 15 },
    { from: '1.20.2', to: '1.20.2', format: 18 },
    { from: '1.20.3', to: '1.20.4', format: 22 },
    { from: '1.20.5', to: '1.20.6', format: 32 },
    { from: '1.21', to: '1.21.1', format: 34 },
    { from: '1.21.2', to: '1.21.3', format: 42 },
    { from: '1.21.4', to: '1.21.4', format: 46 },
    { from: '1.21.5', to: '1.21.5', format: 55 },
    { from: '1.21.6', to: '1.21.6', format: 63 },
    { from: '1.21.7', to: '1.21.8', format: 64 },
];
function versionParts(version) {
    return version
        .split(/[.\-+]/)
        .map((part) => Number.parseInt(part, 10))
        .map((part) => (Number.isFinite(part) ? part : 0));
}
function compareVersion(a, b) {
    const left = versionParts(a);
    const right = versionParts(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0)
            return diff;
    }
    return 0;
}
/** 由 MC 版本推导 pack.mcmeta 的 pack_format 相关字段。 */
export function packFormatFor(mcVersion) {
    const version = mcVersion.trim();
    const hit = PACK_FORMAT_TABLE.find((row) => compareVersion(version, row.from) >= 0 && compareVersion(version, row.to) <= 0);
    if (hit === undefined) {
        const latest = PACK_FORMAT_TABLE[PACK_FORMAT_TABLE.length - 1];
        return {
            pack_format: latest.format,
            exact: false,
            note: `资源包表未覆盖 MC ${version}，已回落为最新已知 pack_format=${latest.format}（对应 ${latest.from}-${latest.to}）。请以实机加载结果为准。`,
        };
    }
    // 1.20.2 起支持 supported_formats 区间，声明后新旧版本都能加载。
    const supported = compareVersion(version, '1.20.2') >= 0
        ? { min_inclusive: hit.format, max_inclusive: hit.format }
        : undefined;
    return {
        pack_format: hit.format,
        ...(supported !== undefined ? { supported_formats: supported } : {}),
        exact: true,
        note: `MC ${version} → pack_format=${hit.format}`,
    };
}
/** 渲染 pack.mcmeta 文本。 */
export function renderPackMcmeta(mcVersion, description) {
    const info = packFormatFor(mcVersion);
    const pack = {
        pack_format: info.pack_format,
        description,
    };
    if (info.supported_formats !== undefined)
        pack.supported_formats = info.supported_formats;
    return {
        text: `${JSON.stringify({ pack }, null, 2)}\n`,
        packFormat: info.pack_format,
        note: info.note,
    };
}
// ── 资源路径校验 ─────────────────────────────────────────────────────────────
/** UI 相关资源的规范目录（相对 assets/<ns>/）。 */
export const UI_ASSET_PATHS = {
    background: 'textures/gui/title/background',
    sprites: 'textures/gui/sprites',
    widgets: 'textures/gui/widgets.png',
    icons: 'textures/gui/icons.png',
    panoramaOverlay: 'textures/gui/title/background/panorama_overlay.png',
};
/**
 * 校验一条资源包内路径是否合法（纹理必须落在 assets/<ns>/textures/ 下且为 .png）。
 * 资源包路径写错不会报错、只会静默不生效，所以这里强制拦截。
 */
export function validateUiAssetPath(input) {
    const path = input.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (path === '')
        return { ok: false, reason: '路径为空', path };
    if (path.includes('..'))
        return { ok: false, reason: '路径包含 ..，拒绝写出资源包之外', path };
    const segments = path.split('/');
    if (segments[0] !== 'assets') {
        return { ok: false, reason: `资源包内容必须放在 assets/<namespace>/ 之下，收到：${path}`, path };
    }
    if (segments.length < 4) {
        return { ok: false, reason: `路径层级不足，至少需要 assets/<namespace>/textures/<file>，收到：${path}`, path };
    }
    const namespace = segments[1] ?? '';
    if (!/^[a-z0-9_.-]+$/.test(namespace)) {
        return { ok: false, reason: `命名空间非法（只允许小写字母、数字、下划线、点、短横线）：${namespace}`, path };
    }
    if (segments[2] !== 'textures' && segments[2] !== 'buttons' && segments[2] !== 'polytone' && segments[2] !== 'lang') {
        return {
            ok: false,
            reason: `assets/<namespace>/ 下只允许 textures / buttons / polytone / lang，收到：${segments[2]}`,
            path,
        };
    }
    if (segments[2] === 'textures' && !path.toLowerCase().endsWith('.png')) {
        return { ok: false, reason: `Minecraft 纹理必须是 PNG，收到：${path}`, path };
    }
    return { ok: true, reason: 'ok', path };
}
const ANCHORS = [
    'TOP_LEFT',
    'TOP_CENTER',
    'TOP_RIGHT',
    'MIDDLE_LEFT',
    'MIDDLE_CENTER',
    'MIDDLE_RIGHT',
    'BOTTOM_LEFT',
    'BOTTOM_CENTER',
    'BOTTOM_RIGHT',
    'DEFAULT',
    'DEFAULT_LOGO',
    'SPLASH',
    'TITLE',
    'JAVAED',
    'FORGE',
];
const ACTIONS = [
    'CONNECT_TO_SERVER',
    'LOAD_WORLD',
    'REALMS',
    'RELOAD',
    'OPEN_GUI',
    'OPEN_URL',
    'QUIT',
    'NONE',
];
const SCREEN_TYPES = [
    'SINGLEPLAYER',
    'MULTIPLAYER',
    'MODS',
    'LANGUAGE',
    'OPTIONS',
    'ACCESSIBILITY',
    'RESOURCE_PACKS',
    'SUPPORTERS',
];
function colorToInt(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value))
        return Math.trunc(value);
    if (typeof value === 'string' && value.trim() !== '')
        return hexToRgbInt(value, fallback);
    return fallback;
}
/**
 * 生成 PackMenu 按钮 JSON（字段名严格对齐 JsonButton.deserialize）。
 * @returns { json, langKey, warning }
 */
export function buildPackMenuButton(button, namespace) {
    const action = button.action.toUpperCase();
    if (!ACTIONS.includes(action)) {
        throw new ModpackError('INVALID_ARGUMENT', `未知的 PackMenu action：${button.action}`);
    }
    const anchor = (button.anchor ?? 'DEFAULT').toUpperCase();
    if (!ANCHORS.includes(anchor)) {
        throw new ModpackError('INVALID_ARGUMENT', `未知的 PackMenu anchor：${button.anchor}`);
    }
    let warning = null;
    const name = slugify(button.name, 'button');
    const langKey = button.langKey ?? `${namespace}.button.${name}`;
    const json = {
        x: clampInt(button.x, -10000, 10000, 0),
        y: clampInt(button.y, -10000, 10000, 0),
        width: clampInt(button.width, 1, 4096, 200),
        height: clampInt(button.height, 1, 4096, 20),
        langKey,
        action,
        anchor,
    };
    if (button.hoverLangKey !== undefined)
        json.hoverLangKey = button.hoverLangKey;
    if (button.texture !== undefined) {
        json.texture = button.texture;
        json.widgets = button.widgets ?? button.texture.includes('widgets');
    }
    else {
        json.texture = 'minecraft:textures/gui/widgets.png';
        json.widgets = button.widgets ?? true;
    }
    if (button.u !== undefined)
        json.u = Math.trunc(button.u);
    if (button.v !== undefined)
        json.v = Math.trunc(button.v);
    if (button.hoverU !== undefined)
        json.hoverU = Math.trunc(button.hoverU);
    if (button.hoverV !== undefined)
        json.hoverV = Math.trunc(button.hoverV);
    if (button.texWidth !== undefined)
        json.texWidth = Math.trunc(button.texWidth);
    if (button.texHeight !== undefined)
        json.texHeight = Math.trunc(button.texHeight);
    if (button.fontColor !== undefined)
        json.fontColor = colorToInt(button.fontColor, 16777215);
    if (button.hoverFontColor !== undefined)
        json.hoverFontColor = colorToInt(button.hoverFontColor, 16777215);
    if (button.textXOffset !== undefined)
        json.textXOffset = Math.trunc(button.textXOffset);
    if (button.textYOffset !== undefined)
        json.textYOffset = Math.trunc(button.textYOffset);
    if (button.dropShadow !== undefined)
        json.dropShadow = button.dropShadow;
    if (button.active !== undefined)
        json.active = button.active;
    if (button.scaleX !== undefined)
        json.scaleX = button.scaleX;
    if (button.scaleY !== undefined)
        json.scaleY = button.scaleY;
    const needsData = action === 'CONNECT_TO_SERVER' || action === 'LOAD_WORLD' || action === 'OPEN_URL' || action === 'OPEN_GUI';
    if (needsData) {
        if (button.data === undefined || button.data.trim() === '') {
            throw new ModpackError('INVALID_ARGUMENT', `PackMenu 的 ${action} 动作必须提供 data（${action === 'CONNECT_TO_SERVER' ? '服务器地址' : action === 'LOAD_WORLD' ? '世界名' : action === 'OPEN_URL' ? '链接' : '界面名'}）`);
        }
        let data = button.data.trim();
        if (action === 'OPEN_GUI') {
            const screen = data.toUpperCase();
            if (!SCREEN_TYPES.includes(screen)) {
                throw new ModpackError('INVALID_ARGUMENT', `OPEN_GUI 的 data 必须是 ScreenType 之一：${SCREEN_TYPES.join(' / ')}，收到 ${button.data}`);
            }
            data = screen;
        }
        json.data = data;
    }
    else if (button.data !== undefined && button.data.trim() !== '') {
        warning = `${action} 动作不接受 data 字段，已忽略`;
    }
    return { json, langKey, warning };
}
/** 渲染 PackMenu 主菜单配置 JSON（config/packmenu.json）。 */
export function buildPackMenuConfig(config) {
    const general = {
        'Draw Title': config.drawTitle ?? true,
        'Draw Splash': config.drawSplash ?? true,
        'Draw Forge Info': config.drawForgeInfo ?? true,
        'Draw Panorama': config.drawPanorama ?? false,
        'Panorama Fade In': config.panoramaFade ?? false,
        'Panorama Speed': config.panoramaSpeed ?? 1,
        'Panorama Variations': clampInt(config.panoramaVariations, 1, 10, 1),
        'Folder Pack': config.folderPack ?? true,
        'Title': {
            'Anchor Point': config.titleAnchor ?? 'TITLE',
            'X Offset': clampInt(config.titleXOffset, -1000, 1000, 0),
            'Y Offset': clampInt(config.titleYOffset, -1000, 1000, 0),
        },
        'Splash Text': {
            'Anchor Point': config.splashAnchor ?? 'SPLASH',
            'X Offset': 0,
            'Y Offset': 0,
        },
        'Forge Info': {
            'Anchor Point': 'FORGE',
            'X Offset': 0,
            'Y Offset': 0,
        },
        'splash text': {
            Rotation: config.splashRotation ?? -20,
            Color: colorToInt(config.splashColor, -16777216),
        },
        slideshow: {
            Textures: config.slideshowTextures ?? [],
            Duration: config.slideshowDuration ?? 200,
            'Transition Duration': config.slideshowTransition ?? 20,
            Repeat: config.slideshowRepeat ?? true,
        },
    };
    return { general };
}
/** 生成 Polytone gui modifier JSON（字段名对齐 GuiModifier.CODEC）。 */
export function buildPolytoneModifier(modifier) {
    const json = {
        target_type: modifier.targetType,
        target: modifier.target,
    };
    if (modifier.titleXOffset !== undefined)
        json.title_x_offset = Math.trunc(modifier.titleXOffset);
    if (modifier.titleYOffset !== undefined)
        json.title_y_offset = Math.trunc(modifier.titleYOffset);
    if (modifier.labelXOffset !== undefined)
        json.label_x_offset = Math.trunc(modifier.labelXOffset);
    if (modifier.labelYOffset !== undefined)
        json.label_y_offset = Math.trunc(modifier.labelYOffset);
    if (modifier.xOffset !== undefined)
        json.x_offset = Math.trunc(modifier.xOffset);
    if (modifier.yOffset !== undefined)
        json.y_offset = Math.trunc(modifier.yOffset);
    if (modifier.widthOffset !== undefined)
        json.width_offset = Math.trunc(modifier.widthOffset);
    if (modifier.heightOffset !== undefined)
        json.height_offset = Math.trunc(modifier.heightOffset);
    if (modifier.titleColor !== undefined)
        json.title_color = colorToInt(modifier.titleColor, 0x404040);
    if (modifier.labelColor !== undefined)
        json.label_color = colorToInt(modifier.labelColor, 0x404040);
    if (modifier.sprites !== undefined && modifier.sprites.length > 0) {
        json.sprites = modifier.sprites.map((sprite) => ({
            texture: sprite.texture,
            x: sprite.x,
            y: sprite.y,
            width: sprite.width,
            height: sprite.height,
            ...(sprite.z !== undefined ? { z: sprite.z } : {}),
            ...(sprite.tooltip !== undefined ? { tooltip: sprite.tooltip } : {}),
        }));
    }
    if (modifier.texts !== undefined && modifier.texts.length > 0) {
        json.texts = modifier.texts.map((text) => ({
            text: text.text,
            x: text.x,
            y: text.y,
            ...(text.z !== undefined ? { z: text.z } : {}),
            ...(text.color !== undefined ? { color: colorToInt(text.color, -1) } : {}),
            ...(text.centered !== undefined ? { centered: text.centered } : {}),
        }));
    }
    if (modifier.slotModifiers !== undefined && modifier.slotModifiers.length > 0)
        json.slot_modifiers = modifier.slotModifiers;
    if (modifier.widgetModifiers !== undefined && modifier.widgetModifiers.length > 0) {
        json.widget_modifiers = modifier.widgetModifiers;
    }
    if (modifier.condition !== undefined && modifier.condition.trim() !== '')
        json.condition = modifier.condition;
    return json;
}
/** 生成 Vistas 的 assets/<ns>/panoramas.json。 */
export function buildVistasPanoramas(entries) {
    const out = {};
    entries.forEach((entry, index) => {
        out[`panorama_${index}`] = {
            weight: entry.weight ?? 1,
            ...(entry.musicSound !== undefined
                ? {
                    musicSound: {
                        sound: entry.musicSound,
                        min_delay: 20,
                        max_delay: 600,
                        replace_current_music: true,
                    },
                }
                : {}),
            cubemaps: [
                {
                    cubemapId: entry.cubemapId,
                    rotationControl: {
                        frozen: entry.frozen ?? false,
                        woozy: false,
                        addedPitch: 0.0,
                        addedYaw: 0.0,
                        addedRoll: 0.0,
                        speedMultiplier: entry.speedMultiplier ?? 1.0,
                    },
                    visualControl: {
                        fov: entry.fov ?? 85.0,
                        width: 2.0,
                        height: 2.0,
                        depth: 2.0,
                        addedX: 0.0,
                        addedY: 0.0,
                        addedZ: 0.0,
                        colorR: 255.0,
                        colorG: 255.0,
                        colorB: 255.0,
                        colorA: 255.0,
                    },
                },
            ],
        };
    });
    return out;
}
async function writePackEntry(root, relPath, data) {
    const absolute = join(root, relPath);
    await writeFileEnsured(absolute, typeof data === 'string' ? data : Buffer.from(data));
    return absolute;
}
/**
 * 组装完整界面材质包。
 * 所有纹理路径都会经过 validateUiAssetPath 校验，非法路径直接 throw。
 */
export async function assembleUiPack(input) {
    const packName = input.packName.trim();
    if (packName === '')
        throw new ModpackError('INVALID_ARGUMENT', 'packName 不能为空');
    const namespace = (input.namespace ?? slugify(packName, 'mypack')).replace(/[^a-z0-9_.-]/g, '');
    const warnings = [];
    const files = [];
    const langEntries = { ...(input.lang ?? {}) };
    const installToResourcePacks = input.installToResourcePacks !== false;
    const alsoWritePackMenu = input.alsoWritePackMenuFolder !== false;
    const resourcePackDir = installToResourcePacks
        ? join(input.packDir, 'resourcepacks', packName)
        : join(input.packDir, '.dsh-ui-pack', packName);
    await ensureDir(resourcePackDir);
    // 1. pack.mcmeta
    const mcmeta = renderPackMcmeta(input.minecraftVersion, input.description ?? `${packName} — generated by dsh-tool-modpack (AI UI pack)`);
    if (!mcmeta.note.includes('→') || mcmeta.note.includes('回落'))
        warnings.push(mcmeta.note);
    await writePackEntry(resourcePackDir, 'pack.mcmeta', mcmeta.text);
    files.push('pack.mcmeta');
    // 2. 纹理
    let textureCount = 0;
    const backgroundTextures = [];
    for (const texture of input.textures ?? []) {
        const check = validateUiAssetPath(texture.path);
        if (!check.ok) {
            throw new ModpackError('INVALID_ASSET_PATH', `纹理路径非法（资源包不会生效）：${texture.path} —— ${check.reason}`);
        }
        await writePackEntry(resourcePackDir, check.path, texture.data);
        files.push(check.path);
        textureCount += 1;
        if (check.path.includes('/textures/gui/title/background/'))
            backgroundTextures.push(texture);
    }
    // 3. PackMenu 按钮
    const buttonFiles = [];
    for (const button of input.buttons ?? []) {
        const built = buildPackMenuButton(button, namespace);
        if (built.warning !== null)
            warnings.push(`${button.name}：${built.warning}`);
        const name = slugify(button.name, 'button');
        const relPath = assetPath(namespace, 'buttons', `${name}.json`);
        const text = `${JSON.stringify(built.json, null, 2)}\n`;
        buttonFiles.push({ relPath, data: text });
        await writePackEntry(resourcePackDir, relPath, text);
        files.push(relPath);
        if (button.text !== undefined && button.text.trim() !== '') {
            langEntries[built.langKey] = button.text;
        }
        else {
            const words = name.split('-').join(' ').replace(/\b\w/g, (char) => char.toUpperCase());
            langEntries[built.langKey] = words;
            warnings.push(`按钮 ${name} 未提供 text，已生成占位文案「${words}」，请在 lang 文件里改成正式文案`);
        }
    }
    // 4. Polytone 修饰符
    for (const modifier of input.modifiers ?? []) {
        const json = buildPolytoneModifier(modifier);
        const relPath = assetPath(namespace, 'polytone', 'gui_modifiers', `${slugify(modifier.name, 'modifier')}.json`);
        const text = `${JSON.stringify(json, null, 2)}\n`;
        await writePackEntry(resourcePackDir, relPath, text);
        files.push(relPath);
        for (const sprite of modifier.sprites ?? []) {
            if (!sprite.texture.includes(':') || sprite.texture.startsWith('minecraft:')) {
                warnings.push(`Polytone sprite ${sprite.texture} 需要指向 gui sprite（形如 ${namespace}:widget/xxx，对应 assets/${namespace}/textures/gui/sprites/widget/xxx.png），否则运行时取不到纹理`);
            }
        }
    }
    // 5. Vistas
    if (input.vistas !== undefined && input.vistas.length > 0) {
        const relPath = assetPath(namespace, 'panoramas.json');
        await writePackEntry(resourcePackDir, relPath, `${JSON.stringify(buildVistasPanoramas(input.vistas), null, 2)}\n`);
        files.push(relPath);
    }
    // 6. 语言文件
    if (Object.keys(langEntries).length > 0) {
        const locale = input.locale ?? 'en_us';
        const relPath = assetPath(namespace, 'lang', `${locale}.json`);
        await writePackEntry(resourcePackDir, relPath, `${JSON.stringify(langEntries, null, 2)}\n`);
        files.push(relPath);
    }
    // 7. PackMenu 自身的内置包目录 + 配置
    let packMenuDir = null;
    if (alsoWritePackMenu) {
        packMenuDir = join(input.packDir, 'packmenu', 'resources');
        await ensureDir(packMenuDir);
        for (const entry of buttonFiles) {
            await writePackEntry(packMenuDir, entry.relPath, entry.data);
        }
        for (const texture of backgroundTextures) {
            const check = validateUiAssetPath(texture.path);
            await writePackEntry(packMenuDir, check.path, texture.data);
        }
        if (buttonFiles.length > 0 || backgroundTextures.length > 0) {
            files.push('packmenu/resources/**（PackMenu folder pack 副本）');
        }
        if (input.packMenu !== undefined) {
            const configPath = join(input.packDir, 'packmenu', 'resources', 'pack.mcmeta');
            if (!(await pathExists(configPath))) {
                await writePackEntry(packMenuDir, 'pack.mcmeta', mcmeta.text);
            }
            await writePackEntry(join(input.packDir, 'config'), 'packmenu.json', `${JSON.stringify(buildPackMenuConfig(input.packMenu), null, 2)}\n`);
            files.push('config/packmenu.json');
        }
        if (input.packMenu === undefined && buttonFiles.length > 0) {
            warnings.push('PackMenu 按钮已写入 packmenu/resources/，但未提供 packMenu 配置：请在 config/packmenu.json 里保持 "Folder Pack": true，否则 PackMenu 会去读 resources.zip。');
        }
    }
    // 8. 可选 zip
    let zipPath = null;
    if (input.zip === true) {
        const zipEntries = [];
        for (const rel of files.filter((file) => !file.includes('**'))) {
            if (rel === 'config/packmenu.json')
                continue;
            const absolute = join(resourcePackDir, rel);
            if (!(await pathExists(absolute)))
                continue;
            zipEntries.push({ path: rel, data: new Uint8Array(await readFile(absolute)) });
        }
        zipPath = input.zipPath ?? join(input.packDir, 'resourcepacks', `${packName}.zip`);
        await writeZip(zipPath, zipEntries);
    }
    return {
        resourcePackDir,
        packMenuDir,
        zipPath,
        packFormat: mcmeta.packFormat,
        packFormatNote: mcmeta.note,
        namespace,
        files: [...new Set(files)],
        textureCount,
        buttonCount: buttonFiles.length,
        modifierCount: (input.modifiers ?? []).length,
        langKeys: Object.keys(langEntries).length,
        warnings: [...new Set(warnings)],
        createdAt: nowIso(),
    };
}
/** 生成一个可用于自检的 UI 包摘要（不落盘）。 */
export function summarizeUiPack(result) {
    return [
        `资源包目录：${result.resourcePackDir}`,
        `pack_format：${result.packFormat}（${result.packFormatNote}）`,
        `纹理 ${result.textureCount} 张，按钮 ${result.buttonCount} 个，Polytone 修饰符 ${result.modifierCount} 个，语言键 ${result.langKeys} 条`,
        result.zipPath !== null ? `分发包：${result.zipPath}` : '未生成 zip',
    ].join('\n');
}
/** 从主题配色派生 UI 配色（供 modpack_gen_ui_theme 使用）。 */
export function deriveThemeColors(primary, secondary, accent) {
    const primaryHex = normalizeHex(primary, '#1E3A8A');
    return {
        primary: primaryHex,
        secondary: normalizeHex(secondary, shade(primaryHex, 0.35)),
        accent: normalizeHex(accent, complement(primaryHex)),
        background: shade(primaryHex, 0.75),
        text: '#E8EDF7',
        hsl: rgbToHsl(primaryHex),
    };
}
function hexToRgbTuple(hex) {
    const value = Number.parseInt(normalizeHex(hex, '#000000').slice(1), 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
function rgbTupleToHex(rgb) {
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
    return `#${[clamp(rgb[0]), clamp(rgb[1]), clamp(rgb[2])]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()}`;
}
/** 按比例变暗（0 = 原色，1 = 全黑）。 */
export function shade(hex, amount) {
    const ratio = Math.max(0, Math.min(1, amount));
    const [r, g, b] = hexToRgbTuple(hex);
    return rgbTupleToHex([r * (1 - ratio), g * (1 - ratio), b * (1 - ratio)]);
}
/** 取补色（用于强调色）。 */
export function complement(hex) {
    const [r, g, b] = hexToRgbTuple(hex);
    return rgbTupleToHex([255 - r, 255 - g, 255 - b]);
}
/** RGB → HSL。 */
export function rgbToHsl(hex) {
    const [r255, g255, b255] = hexToRgbTuple(hex);
    const r = r255 / 255;
    const g = g255 / 255;
    const b = b255 / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r)
            h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g)
            h = ((b - r) / d + 2) / 6;
        else
            h = ((r - g) / d + 4) / 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}
/** 用纯 JS 生成一张占位 PNG（sharp 不可用或只想要纯色底时的兜底）。 */
export function placeholderTexture(width, height, palette) {
    return solidPng(width, height, palette.base, 255);
}
/** 生成带强调色描边的占位纹理（用于图标/HUD 的临时占位）。 */
export function placeholderFramedTexture(width, height, palette) {
    const rgba = new Uint8Array(width * height * 4);
    const base = normalizeHex(palette.base, '#1E3A8A');
    const accent = normalizeHex(palette.accent, '#38BDF8');
    const toRgb = (hex) => {
        const value = Number.parseInt(hex.slice(1), 16);
        return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    };
    const [br, bg, bb] = toRgb(base);
    const [ar, ag, ab] = toRgb(accent);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
            const index = (y * width + x) * 4;
            rgba[index] = edge ? ar : br;
            rgba[index + 1] = edge ? ag : bg;
            rgba[index + 2] = edge ? ab : bb;
            rgba[index + 3] = 255;
        }
    }
    return encodePng(width, height, rgba);
}
/** 汇总 zip 内条目（供测试断言）。 */
export function zipEntryList(entries) {
    return entries.map((entry) => entry.path).sort((a, b) => a.localeCompare(b));
}
/** 便捷：把若干条目打包成资源包 zip 字节（不落盘）。 */
export function buildResourcePackZip(entries) {
    return buildZip(entries);
}
/** 便捷：把一批纹理直接打包成资源包 zip 文件。 */
export async function zipUiTextures(file, textures, mcVersion, description) {
    const mcmeta = renderPackMcmeta(mcVersion, description);
    const entries = [
        { path: 'pack.mcmeta', data: Buffer.from(mcmeta.text, 'utf8') },
    ];
    for (const texture of textures) {
        const check = validateUiAssetPath(texture.path);
        if (!check.ok) {
            throw new ModpackError('INVALID_ASSET_PATH', `纹理路径非法：${texture.path} —— ${check.reason}`);
        }
        entries.push({ path: check.path, data: texture.data });
    }
    await writeZip(file, entries);
    return { path: file, entries: zipEntryList(entries), packFormat: mcmeta.packFormat };
}
//# sourceMappingURL=ui-pack.js.map