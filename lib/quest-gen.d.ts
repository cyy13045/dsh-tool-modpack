/**
 * dsh-tool-modpack — FTB Quests 任务书（SNBT）生成器。
 *
 * 纯文本生成 + 自研 SNBT 序列化器，不依赖任何 Minecraft/FTB 代码。
 * 生成的文件布局（FTB Quests 1.20.x）：
 *   config/ftbquests/quests/chapter_groups.snbt
 *   config/ftbquests/quests/chapters/<filename>.snbt
 *   config/ftbquests/quests/data.snbt
 *
 * 任务/章节 id 由内容确定性派生（sha1 → 16 位大写十六进制），
 * 因此重复生成同一份任务书是幂等的，不会打断玩家的已完成进度。
 *
 * @module dsh-tool-modpack/quest-gen
 */
/** 原样输出的 SNBT 片段（用于 1.0d / 8L 这类带类型后缀的数字）。 */
export declare class SnbtRaw {
    readonly text: string;
    constructor(text: string);
}
/** 构造原样片段。 */
export declare function raw(text: string): SnbtRaw;
/** 双精度浮点（FTBQ 里坐标一律带 d 后缀）。 */
export declare function asDouble(value: number): SnbtRaw;
/** 长整数（物品数量带 L 后缀）。 */
export declare function asLong(value: number): SnbtRaw;
/** SNBT 字符串转义（FTBQ 使用标准 Java 风格转义）。 */
export declare function snbtString(value: string): string;
/**
 * 把 JSON 风格的值序列化为 SNBT。
 * @param indent 当前缩进层级（每层一个制表符，与 FTBQ 一致）
 */
export declare function snbtLiteral(value: unknown, indent?: number): string;
/** 由种子确定性派生 16 位大写十六进制 id（FTBQ 的 id 形态）。 */
export declare function questId(seed: string): string;
/** 任务类型。 */
export type QuestTaskType = 'item' | 'item_tag' | 'advancement' | 'dimension' | 'stat' | 'kill' | 'xp' | 'observation' | 'checkmark' | 'stage' | 'biome' | 'structure';
/** 一个任务目标。 */
export interface QuestTask {
    type: QuestTaskType;
    /** item / item_tag 用。 */
    item?: string;
    tag?: string;
    count?: number;
    /** advancement / stage / biome / structure 用。 */
    id?: string;
    /** dimension 用，例如 minecraft:the_nether。 */
    dimension?: string;
    /** kill 用，实体 id。 */
    entity?: string;
    /** stat 用：stat id 与目标值。 */
    stat?: string;
    value?: number;
    /** 界面标题（缺省由生成器推导）。 */
    title?: string;
    /** 观察型任务（observation）的观察目标与范围。 */
    observe?: string;
    range?: number;
    /** stage 类型任务的阶段名。 */
    stage?: string;
    /** 是否仅服务端判定。 */
    onlyFrom?: 'player' | 'server';
}
/** 奖励类型。 */
export type QuestRewardType = 'item' | 'xp' | 'xp_levels' | 'loot' | 'command' | 'choice' | 'random' | 'stage' | 'toast';
/** 一个奖励。 */
export interface QuestReward {
    type: QuestRewardType;
    item?: string;
    count?: number;
    xp?: number;
    levels?: number;
    command?: string;
    tableId?: string;
    stage?: string;
    title?: string;
    /** toast 奖励的副标题。 */
    subtitle?: string;
    /** command/random 的玩家执行权限。 */
    silent?: boolean;
    /** choice 奖励里包裹的表项。 */
    entries?: QuestReward[];
}
/** 一个任务节点。 */
export interface QuestDraft {
    /** 不填则按 title + 坐标确定性派生。 */
    id?: string;
    title: string;
    subtitle?: string;
    description?: string[];
    /** 图标，例如 minecraft:crafting_table。 */
    icon?: string;
    x: number;
    y: number;
    size?: number;
    shape?: 'circle' | 'square' | 'diamond' | 'hexagon' | 'pentagon' | 'rsquare' | 'gear';
    tasks: QuestTask[];
    rewards?: QuestReward[];
    /** 依赖的前置任务 id 列表。 */
    dependencies?: string[];
    optional?: boolean;
    hidden?: boolean;
    invisible?: boolean;
    /** 是否隐藏任务连线上的依赖关系。 */
    hideDependencyLines?: boolean;
    /** 是否禁止玩家手动领取奖励。 */
    disableRewardScreenBlur?: boolean;
    tags?: string[];
}
/** 一个章节。 */
export interface ChapterDraft {
    id?: string;
    /** 文件名（不含 .snbt），缺省由 title 派生。 */
    filename?: string;
    title: string;
    subtitle?: string;
    /** 所属章节组标题；会在 chapter_groups.snbt 里自动建组。 */
    group?: string;
    orderIndex?: number;
    /** 章节图标。 */
    icon?: string;
    /** 默认任务形状。 */
    defaultQuestShape?: string;
    quests: QuestDraft[];
}
/** 任务书生成输入。 */
export interface QuestBookInput {
    packDir: string;
    /** 任务书标题（写进 data.snbt 与章节组）。 */
    title: string;
    chapters: ChapterDraft[];
    /** 是否自动串联同章节内相邻任务（按 x/y 推进顺序）。默认 false。 */
    autoChain?: boolean;
    /** 自动串联时首个任务的额外依赖（通常留空）。 */
    chainFromQuestId?: string;
    /** 是否覆盖已存在的章节文件（默认 true，配合确定性 id 安全）。 */
    overwrite?: boolean;
    /** 只生成不落盘（干跑），用于预览文件清单与警告。 */
    dryRun?: boolean;
}
/** 生成结果。 */
export interface QuestBookResult {
    files: string[];
    chapters: number;
    quests: number;
    tasks: number;
    rewards: number;
    chapterGroups: number;
    /** 任务 id 一览（模型后续可用它写 dependencies）。 */
    questIndex: Array<{
        id: string;
        chapter: string;
        title: string;
    }>;
    warnings: string[];
    createdAt: string;
}
/** 渲染一个章节的 SNBT 文本。 */
export declare function renderChapterSnbt(chapter: ChapterDraft, groupId: string): string;
/** 渲染 chapter_groups.snbt。 */
export declare function renderChapterGroupsSnbt(groups: Array<{
    id: string;
    title: string;
}>): string;
/** 渲染 data.snbt。 */
export declare function renderDataSnbt(title: string): string;
/**
 * 生成完整 FTB Quests 任务书到 packDir。
 * 写入 config/ftbquests/quests/ 下的章节、章节组与 data.snbt。
 */
export declare function generateQuestBook(input: QuestBookInput): Promise<QuestBookResult>;
/** 任务书章节草稿的最小校验（供测试与工具参数自检）。 */
export declare function validateChapterDraft(chapter: ChapterDraft): string[];
/** 归一化坐标，避免任务重叠（同一格重复时向右平移）。 */
export declare function dedupeQuestPositions(quests: QuestDraft[], step?: number): QuestDraft[];
/** 依据任务规模给出建议的章节大小（供 UI/排版使用）。 */
export declare function suggestQuestSize(quest: QuestDraft): number;
//# sourceMappingURL=quest-gen.d.ts.map