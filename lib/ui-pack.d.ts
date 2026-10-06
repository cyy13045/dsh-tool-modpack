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
import { type ZipEntry } from './packer.js';
/** 一个 pack_format 区间。 */
export interface PackFormatRange {
    /** 支持的 MC 版本（含端点），按字符串比较前先归一化。 */
    from: string;
    to: string;
    format: number;
}
/**
 * 资源包 pack_format 对照表（原版 ResourcePackFormat 常量）。
 * 表只覆盖到 1.21.8；更新的版本回落到最新的已知值并给出警告。
 */
export declare const PACK_FORMAT_TABLE: readonly PackFormatRange[];
/** 由 MC 版本推导 pack.mcmeta 的 pack_format 相关字段。 */
export declare function packFormatFor(mcVersion: string): {
    pack_format: number;
    supported_formats?: {
        min_inclusive: number;
        max_inclusive: number;
    };
    exact: boolean;
    note: string;
};
/** 渲染 pack.mcmeta 文本。 */
export declare function renderPackMcmeta(mcVersion: string, description: string): {
    text: string;
    packFormat: number;
    note: string;
};
/** UI 相关资源的规范目录（相对 assets/<ns>/）。 */
export declare const UI_ASSET_PATHS: {
    readonly background: "textures/gui/title/background";
    readonly sprites: "textures/gui/sprites";
    readonly widgets: "textures/gui/widgets.png";
    readonly icons: "textures/gui/icons.png";
    readonly panoramaOverlay: "textures/gui/title/background/panorama_overlay.png";
};
/** 校验结果。 */
export interface AssetPathCheck {
    ok: boolean;
    reason: string;
    /** 归一化后的路径（正斜杠）。 */
    path: string;
}
/**
 * 校验一条资源包内路径是否合法（纹理必须落在 assets/<ns>/textures/ 下且为 .png）。
 * 资源包路径写错不会报错、只会静默不生效，所以这里强制拦截。
 */
export declare function validateUiAssetPath(input: string): AssetPathCheck;
/** 一条待写入资源包的纹理。 */
export interface UiTextureInput {
    /** 相对资源包根的路径，例如 assets/mypack/textures/gui/sprites/icon/gear.png。 */
    path: string;
    /** PNG 字节。 */
    data: Uint8Array;
    /** 用途备注（写进结果便于模型核对）。 */
    role?: string;
}
/** PackMenu 按钮锚点（对应 AnchorPoint 枚举）。 */
export type PackMenuAnchor = 'TOP_LEFT' | 'TOP_CENTER' | 'TOP_RIGHT' | 'MIDDLE_LEFT' | 'MIDDLE_CENTER' | 'MIDDLE_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_CENTER' | 'BOTTOM_RIGHT' | 'DEFAULT' | 'DEFAULT_LOGO' | 'SPLASH' | 'TITLE' | 'JAVAED' | 'FORGE';
/** PackMenu 按钮动作（对应 ButtonAction 枚举）。 */
export type PackMenuAction = 'CONNECT_TO_SERVER' | 'LOAD_WORLD' | 'REALMS' | 'RELOAD' | 'OPEN_GUI' | 'OPEN_URL' | 'QUIT' | 'NONE';
/** OPEN_GUI 的目标界面（对应 ScreenType 枚举）。 */
export type PackMenuScreenType = 'SINGLEPLAYER' | 'MULTIPLAYER' | 'MODS' | 'LANGUAGE' | 'OPTIONS' | 'ACCESSIBILITY' | 'RESOURCE_PACKS' | 'SUPPORTERS';
/** 一个 PackMenu 按钮定义。 */
export interface PackMenuButton {
    /** 文件名（不含 .json）。 */
    name: string;
    /** 显示文本的语言键，例如 mymodpack.button.play。 */
    langKey?: string;
    /** 悬停文本语言键；缺省时 PackMenu 回落为 langKey。 */
    hoverLangKey?: string;
    /** 直接给的显示文本（会自动生成 langKey 并在 lang 文件里登记）。 */
    text?: string;
    action: PackMenuAction;
    /** CONNECT_TO_SERVER 的服务器地址 / LOAD_WORLD 的世界名 / OPEN_URL 的链接 / OPEN_GUI 的界面名。 */
    data?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    /** 纹理资源位置，例如 mypack:textures/gui/sprites/widget/button.png。 */
    texture?: string;
    u?: number;
    v?: number;
    hoverU?: number;
    hoverV?: number;
    texWidth?: number;
    texHeight?: number;
    /** 是否按原版 widgets 纹理做九宫拉伸（默认由纹理名是否含 widgets 决定）。 */
    widgets?: boolean;
    anchor?: PackMenuAnchor;
    fontColor?: string | number;
    hoverFontColor?: string | number;
    textXOffset?: number;
    textYOffset?: number;
    dropShadow?: boolean;
    active?: boolean;
    scaleX?: number;
    scaleY?: number;
}
/** PackMenu 主菜单配置（对应 config/packmenu.json 的 placebo 配置键）。 */
export interface PackMenuConfig {
    drawTitle?: boolean;
    drawSplash?: boolean;
    drawForgeInfo?: boolean;
    drawPanorama?: boolean;
    panoramaFade?: boolean;
    panoramaSpeed?: number;
    panoramaVariations?: number;
    /** 从 gamedir/packmenu/resources 读取而不是 resources.zip。 */
    folderPack?: boolean;
    /** 幻灯片纹理列表（资源位置字符串）。 */
    slideshowTextures?: string[];
    slideshowDuration?: number;
    slideshowTransition?: number;
    slideshowRepeat?: boolean;
    titleAnchor?: PackMenuAnchor;
    titleXOffset?: number;
    titleYOffset?: number;
    splashAnchor?: PackMenuAnchor;
    splashColor?: string | number;
    splashRotation?: number;
}
/**
 * 生成 PackMenu 按钮 JSON（字段名严格对齐 JsonButton.deserialize）。
 * @returns { json, langKey, warning }
 */
export declare function buildPackMenuButton(button: PackMenuButton, namespace: string): {
    json: Record<string, unknown>;
    langKey: string;
    warning: string | null;
};
/** 渲染 PackMenu 主菜单配置 JSON（config/packmenu.json）。 */
export declare function buildPackMenuConfig(config: PackMenuConfig): Record<string, unknown>;
/** Polytone 目标类型。 */
export type PolytoneTargetType = 'menu_id' | 'menu_class' | 'screen_class' | 'screen_title';
/** Polytone 界面上的精灵。 */
export interface PolytoneSprite {
    /** GUI sprite 资源位置（不带 textures/ 前缀与 .png 后缀），例如 mypack:widget/frame。 */
    texture: string;
    x: number;
    y: number;
    width: number;
    height: number;
    z?: number;
    tooltip?: string;
}
/** Polytone 界面上的文本。 */
export interface PolytoneText {
    text: string;
    x: number;
    y: number;
    z?: number;
    color?: string | number;
    centered?: boolean;
}
/** Polytone GUI 修饰符。 */
export interface PolytoneGuiModifier {
    name: string;
    targetType: PolytoneTargetType;
    target: string;
    titleXOffset?: number;
    titleYOffset?: number;
    labelXOffset?: number;
    labelYOffset?: number;
    xOffset?: number;
    yOffset?: number;
    widthOffset?: number;
    heightOffset?: number;
    titleColor?: string | number;
    labelColor?: string | number;
    sprites?: PolytoneSprite[];
    texts?: PolytoneText[];
    slotModifiers?: Array<Record<string, unknown>>;
    widgetModifiers?: Array<Record<string, unknown>>;
    condition?: string;
}
/** 生成 Polytone gui modifier JSON（字段名对齐 GuiModifier.CODEC）。 */
export declare function buildPolytoneModifier(modifier: PolytoneGuiModifier): Record<string, unknown>;
/** Vistas 全景条目。 */
export interface VistasPanoramaEntry {
    /** 资源位置基名，例如 mypack:textures/gui/title/background/panorama。 */
    cubemapId: string;
    weight?: number;
    /** 是否冻结旋转。 */
    frozen?: boolean;
    speedMultiplier?: number;
    fov?: number;
    /** 菜单音乐资源，例如 minecraft:music.menu。 */
    musicSound?: string;
}
/** 生成 Vistas 的 assets/<ns>/panoramas.json。 */
export declare function buildVistasPanoramas(entries: VistasPanoramaEntry[]): Record<string, unknown>;
/** 组装输入。 */
export interface AssembleUiPackInput {
    /** 整合包实例根目录。 */
    packDir: string;
    /** 资源包名（同时作为资源包目录名与默认命名空间）。 */
    packName: string;
    /** 命名空间，默认由 packName 派生。 */
    namespace?: string;
    minecraftVersion: string;
    description?: string;
    /** 已生成好的纹理（路径必须是资源包内路径）。 */
    textures?: UiTextureInput[];
    /** PackMenu 按钮。 */
    buttons?: PackMenuButton[];
    /** PackMenu 主菜单配置；给了就写 config/packmenu.json。 */
    packMenu?: PackMenuConfig;
    /** Polytone 修饰符。 */
    modifiers?: PolytoneGuiModifier[];
    /** Vistas 全景条目。 */
    vistas?: VistasPanoramaEntry[];
    /** 额外语言条目（自动生成的语言条目会与之合并）。 */
    lang?: Record<string, string>;
    /** 语言文件区域，默认 en_us。 */
    locale?: string;
    /** 是否写进 resourcepacks/<packName>/（默认 true）。 */
    installToResourcePacks?: boolean;
    /** 是否把 PackMenu 需要的部分同步到 packmenu/resources/（默认 true）。 */
    alsoWritePackMenuFolder?: boolean;
    /** 是否额外产出一个可分发 zip（默认 false）。 */
    zip?: boolean;
    /** zip 输出路径；缺省为 resourcepacks 目录旁的 <packName>.zip。 */
    zipPath?: string;
}
/** 组装结果。 */
export interface AssembleUiPackResult {
    resourcePackDir: string;
    packMenuDir: string | null;
    zipPath: string | null;
    packFormat: number;
    packFormatNote: string;
    namespace: string;
    files: string[];
    textureCount: number;
    buttonCount: number;
    modifierCount: number;
    langKeys: number;
    warnings: string[];
    createdAt: string;
}
/**
 * 组装完整界面材质包。
 * 所有纹理路径都会经过 validateUiAssetPath 校验，非法路径直接 throw。
 */
export declare function assembleUiPack(input: AssembleUiPackInput): Promise<AssembleUiPackResult>;
/** 生成一个可用于自检的 UI 包摘要（不落盘）。 */
export declare function summarizeUiPack(result: AssembleUiPackResult): string;
/** 从主题配色派生 UI 配色（供 modpack_gen_ui_theme 使用）。 */
export declare function deriveThemeColors(primary: string, secondary?: string, accent?: string): {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    hsl: {
        h: number;
        s: number;
        l: number;
    };
};
/** 按比例变暗（0 = 原色，1 = 全黑）。 */
export declare function shade(hex: string, amount: number): string;
/** 取补色（用于强调色）。 */
export declare function complement(hex: string): string;
/** RGB → HSL。 */
export declare function rgbToHsl(hex: string): {
    h: number;
    s: number;
    l: number;
};
/** 用纯 JS 生成一张占位 PNG（sharp 不可用或只想要纯色底时的兜底）。 */
export declare function placeholderTexture(width: number, height: number, palette: {
    base: string;
    accent?: string;
}): Buffer;
/** 生成带强调色描边的占位纹理（用于图标/HUD 的临时占位）。 */
export declare function placeholderFramedTexture(width: number, height: number, palette: {
    base: string;
    accent: string;
}): Buffer;
/** 汇总 zip 内条目（供测试断言）。 */
export declare function zipEntryList(entries: ZipEntry[]): string[];
/** 便捷：把若干条目打包成资源包 zip 字节（不落盘）。 */
export declare function buildResourcePackZip(entries: ZipEntry[]): Buffer;
/** 便捷：把一批纹理直接打包成资源包 zip 文件。 */
export declare function zipUiTextures(file: string, textures: UiTextureInput[], mcVersion: string, description: string): Promise<{
    path: string;
    entries: string[];
    packFormat: number;
}>;
//# sourceMappingURL=ui-pack.d.ts.map