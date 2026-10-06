/**
 * dsh-tool-modpack — 插件入口。
 *
 * 导出 Cordis 契约所需的三件套：`name` / `inject` / `apply`。
 * apply 内通过 `ctx.tools.register(defineTool({...}))` 注册 **22 个** 工具，
 * 按整合包制作流程分 7 个阶段。插件卸载时由 Cordis 自动注销全部工具。
 *
 * 阶段划分：
 *   一 规划与初始化（3）：modpack_plan / modpack_create / modpack_setup_env
 *   二 模组管理（5）    ：modpack_search_mods / modpack_add_mod / modpack_resolve_deps
 *                         modpack_check_conflicts / modpack_add_optimization
 *   三 配置与内容（4）  ：modpack_gen_config / modpack_gen_quests / modpack_add_resources / modpack_gen_readme
 *   四 界面设计（4）    ：modpack_gen_ui_theme / modpack_gen_menu_bg / modpack_gen_ui_textures / modpack_assemble_ui_pack
 *   五 本地化（2）      ：modpack_scan_i18n / modpack_translate
 *   六 测试与验证（2）  ：modpack_validate / modpack_gen_test_plan
 *   七 打包与发布（2）  ：modpack_export / modpack_publish
 *
 * 约定：execute 只返回一个 canonical 值；任何网络/磁盘故障直接 throw（即 isError）。
 *
 * @module dsh-tool-modpack
 */
import type { Context } from '@deepseek-ai/cordis';
import { GlossaryTranslator, renderUntranslatedNotice } from './i18n.js';
/** 插件名。 */
export declare const name = "dsh-tool-modpack";
/** 依赖的 Host 服务：只依赖 tools。 */
export declare const inject: readonly ["tools"];
/** 由 MC 版本推导所需 Java 主版本。 */
export declare function javaVersionFor(minecraftVersion: string): {
    major: number;
    note: string;
};
/** Aikar 风格 G1GC 参数（业界通用的大内存 Minecraft 服务端/客户端调优模板）。 */
export declare function jvmArgsFor(memoryGb: number, extra?: string[]): string[];
/** 由模组数量给出建议内存。 */
export declare function suggestMemoryGb(modCount: number, modCount2?: number): number;
/**
 * Cordis 插件入口。
 * `inject: ['tools']` 保证 tools 服务就绪后才 apply；注册的工具在插件卸载时由 Cordis 自动注销。
 */
export declare function apply(ctx: Context, _config?: unknown): void;
/** 22 个工具名的权威清单（供自检与文档使用）。 */
export declare const TOOL_NAMES: readonly string[];
/** Modrinth API 根地址（便于外部核对）。 */
export declare const MODRINTH_BASE_URL = "https://api.modrinth.com/v2";
/** 供测试复用：术语表翻译器与未翻译提示。 */
export { GlossaryTranslator, renderUntranslatedNotice };
//# sourceMappingURL=index.d.ts.map