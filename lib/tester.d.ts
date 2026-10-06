/**
 * dsh-tool-modpack — 测试与验证模块。
 *
 * validatePack：对整合包目录做结构与内容校验（模组、依赖、配置语法、资源包、
 * 任务书、启动器配置、敏感文件泄漏）。
 * generateTestPlan：产出可执行的测试检查清单（供人类或 Agent 逐条过）。
 *
 * 所有校验都返回"结构化问题列表 + markdown 报告"，不抛异常（除了目录不存在）。
 *
 * @module dsh-tool-modpack/tester
 */
/** 问题严重级别。 */
export type IssueSeverity = 'error' | 'warning' | 'info';
/** 一条校验问题。 */
export interface ValidationIssue {
    code: string;
    severity: IssueSeverity;
    message: string;
    /** 相关文件（相对 packDir）。 */
    file: string | null;
    /** 修复建议。 */
    hint: string | null;
}
/** 单项检查结果。 */
export interface ValidationCheck {
    name: string;
    status: 'pass' | 'warn' | 'fail';
    detail: string;
}
/** 校验输入。 */
export interface ValidatePackInput {
    packDir: string;
    minecraftVersion: string;
    loader: string;
    /** 期望存在的模组（projectId/slug），用于核对依赖清单。 */
    expectedMods?: Array<{
        slug: string;
        projectId?: string;
        required?: boolean;
    }>;
    /** 期望存在的依赖（projectId → 被谁需要）。 */
    requiredDependencies?: Array<{
        slug: string;
        requestedBy?: string[];
    }>;
    /** 是否校验敏感信息泄漏（默认 true）。 */
    scanSecrets?: boolean;
    /** 是否校验资源包与任务书（默认 true）。 */
    deep?: boolean;
}
/** 校验结果。 */
export interface ValidatePackResult {
    ok: boolean;
    verdict: 'ok' | 'warning' | 'broken';
    checks: ValidationCheck[];
    issues: ValidationIssue[];
    stats: {
        mods: number;
        disabledMods: number;
        configFiles: number;
        resourcePacks: number;
        questChapters: number;
        quests: number;
        totalBytes: number;
    };
    report: string;
    createdAt: string;
}
/** 检查 JSON 文本是否可解析。 */
export declare function isValidJson(text: string): {
    ok: boolean;
    reason: string;
};
/** 检查 SNBT 文本的括号是否配平（含引号转义处理）。 */
export declare function isBalancedSnbt(text: string): {
    ok: boolean;
    reason: string;
};
/** 检查 TOML 是否能通过"键值行 + 表头"的粗校验。 */
export declare function isPlausibleToml(text: string): {
    ok: boolean;
    reason: string;
};
/** 校验整合包。 */
export declare function validatePack(input: ValidatePackInput): Promise<ValidatePackResult>;
/** 测试计划输入。 */
export interface TestPlanInput {
    packName: string;
    minecraftVersion: string;
    loader: string;
    /** 主题，用于生成针对性检查。 */
    theme?: string;
    /** 功能模块（如 ['科技','任务书','自定义主界面','光影']）。 */
    features?: string[];
    /** 模组数量，用于估算启动耗时阈值。 */
    modCount?: number;
    /** 目标最低帧率。 */
    targetFps?: number;
    /** 是否有服务端。 */
    serverSide?: boolean;
    /** 分配内存（GB）。 */
    memoryGb?: number;
}
/** 测试计划结果。 */
export interface TestPlanResult {
    checklist: Array<{
        section: string;
        items: Array<{
            id: string;
            text: string;
            expected: string;
            severity: 'blocker' | 'major' | 'minor';
        }>;
    }>;
    markdown: string;
    estimatedMinutes: number;
    createdAt: string;
}
/** 生成测试检查清单。 */
export declare function generateTestPlan(input: TestPlanInput): TestPlanResult;
//# sourceMappingURL=tester.d.ts.map