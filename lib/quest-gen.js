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
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ModpackError, clampInt, ensureDir, nowIso, pathExists, requireString, slugify, writeFileEnsured } from './util.js';
// ── SNBT 序列化 ──────────────────────────────────────────────────────────────
/** 原样输出的 SNBT 片段（用于 1.0d / 8L 这类带类型后缀的数字）。 */
export class SnbtRaw {
    text;
    constructor(text) {
        this.text = text;
    }
}
/** 构造原样片段。 */
export function raw(text) {
    return new SnbtRaw(text);
}
/** 双精度浮点（FTBQ 里坐标一律带 d 后缀）。 */
export function asDouble(value) {
    const normalized = Number.isFinite(value) ? value : 0;
    return new SnbtRaw(`${Number.isInteger(normalized) ? normalized.toFixed(1) : String(normalized)}d`);
}
/** 长整数（物品数量带 L 后缀）。 */
export function asLong(value) {
    return new SnbtRaw(`${Math.trunc(Number.isFinite(value) ? value : 0)}L`);
}
/** SNBT 字符串转义（FTBQ 使用标准 Java 风格转义）。 */
export function snbtString(value) {
    const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r\n/g, '\\n')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\n')
        .replace(/\t/g, '\\t');
    return `"${escaped}"`;
}
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
function snbtKey(key) {
    return BARE_KEY.test(key) ? key : snbtString(key);
}
/**
 * 把 JSON 风格的值序列化为 SNBT。
 * @param indent 当前缩进层级（每层一个制表符，与 FTBQ 一致）
 */
export function snbtLiteral(value, indent = 0) {
    const pad = '\t'.repeat(indent);
    const innerPad = '\t'.repeat(indent + 1);
    if (value === null || value === undefined)
        return '""';
    if (value instanceof SnbtRaw)
        return value.text;
    if (typeof value === 'string')
        return snbtString(value);
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            return '0';
        return Number.isInteger(value) ? String(value) : String(value);
    }
    if (Array.isArray(value)) {
        if (value.length === 0)
            return '[]';
        const simple = value.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item instanceof SnbtRaw);
        if (simple && value.length <= 4) {
            return `[${value.map((item) => snbtLiteral(item, indent)).join(', ')}]`;
        }
        const body = value.map((item) => `${innerPad}${snbtLiteral(item, indent + 1)}`).join('\n');
        return `[\n${body}\n${pad}]`;
    }
    const record = value;
    const entries = Object.entries(record).filter(([, item]) => item !== undefined);
    if (entries.length === 0)
        return '{}';
    const body = entries
        .map(([key, item]) => `${innerPad}${snbtKey(key)}: ${snbtLiteral(item, indent + 1)}`)
        .join('\n');
    return `{\n${body}\n${pad}}`;
}
// ── id 派生 ──────────────────────────────────────────────────────────────────
/** 由种子确定性派生 16 位大写十六进制 id（FTBQ 的 id 形态）。 */
export function questId(seed) {
    return createHash('sha1').update(seed).digest('hex').slice(0, 16).toUpperCase();
}
// ── 渲染 ─────────────────────────────────────────────────────────────────────
function normalizeItemId(value) {
    const trimmed = value.trim();
    if (trimmed === '')
        throw new ModpackError('INVALID_ARGUMENT', '物品 id 不能为空');
    const withCount = trimmed.match(/^(.+?)\s*[x*]\s*(\d+)$/);
    if (withCount !== null)
        return withCount[1].trim();
    return trimmed.includes(':') ? trimmed : `minecraft:${trimmed}`;
}
function parseStackCount(value) {
    const match = value.trim().match(/^(.+?)\s*[x*]\s*(\d+)$/);
    return match === null ? null : Number.parseInt(match[2], 10);
}
function taskToSnbt(task, seed, index) {
    const id = questId(`${seed}:task:${index}`);
    const base = { id, type: task.type };
    switch (task.type) {
        case 'item': {
            base.item = { id: normalizeItemId(task.item ?? '') };
            base.count = asLong(task.count ?? parseStackCount(task.item ?? '') ?? 1);
            break;
        }
        case 'item_tag': {
            base.item = { tag: task.tag ?? 'minecraft:logs' };
            base.count = asLong(task.count ?? 1);
            break;
        }
        case 'advancement':
            base.advancement = task.id ?? 'minecraft:story/root';
            break;
        case 'dimension':
            base.dimension = task.dimension ?? task.id ?? 'minecraft:overworld';
            break;
        case 'kill':
            base.entity = task.entity ?? task.id ?? 'minecraft:zombie';
            base.value = asLong(task.value ?? 1);
            break;
        case 'xp':
            base.value = asLong(task.value ?? 1);
            break;
        case 'stat':
            base.stat = task.stat ?? 'minecraft:custom:minecraft:play_time';
            base.value = asLong(task.value ?? 1);
            break;
        case 'observation':
            base.observe_type = task.observe ?? 'minecraft:block';
            base.to_observe = { id: normalizeItemId(task.id ?? 'minecraft:crafting_table') };
            base.range = asDouble(task.range ?? 4);
            break;
        case 'checkmark':
            break;
        case 'stage':
            base.stage = task.stage ?? task.id ?? 'stage_1';
            break;
        case 'biome':
            base.biome = task.id ?? 'minecraft:plains';
            break;
        case 'structure':
            base.structure = task.id ?? 'minecraft:village_plains';
            break;
        default:
            throw new ModpackError('UNSUPPORTED_TASK', `不支持的任务类型：${String(task.type)}`);
    }
    if (task.title !== undefined)
        base.title = task.title;
    else
        base.title = defaultTaskTitle(task);
    if (task.onlyFrom === 'server')
        base.only_from = 'server';
    return base;
}
function defaultTaskTitle(task) {
    const item = task.item !== undefined ? normalizeItemId(task.item) : '';
    switch (task.type) {
        case 'item':
            return `获取 ${task.count ?? 1} 个 ${item}`;
        case 'item_tag':
            return `获取 ${task.count ?? 1} 个 ${task.tag ?? ''}`;
        case 'advancement':
            return `完成进度 ${task.id ?? ''}`;
        case 'dimension':
            return `进入维度 ${task.dimension ?? task.id ?? ''}`;
        case 'kill':
            return `击杀 ${task.value ?? 1} 个 ${task.entity ?? ''}`;
        case 'xp':
            return `获得 ${task.value ?? 1} 点经验`;
        case 'stat':
            return `达成统计 ${task.stat ?? ''} = ${task.value ?? 1}`;
        case 'observation':
            return `观察 ${task.id ?? ''}`;
        case 'checkmark':
            return '手动确认';
        case 'stage':
            return `解锁阶段 ${task.stage ?? task.id ?? ''}`;
        case 'biome':
            return `抵达生物群系 ${task.id ?? ''}`;
        case 'structure':
            return `发现结构 ${task.id ?? ''}`;
        default:
            return '任务目标';
    }
}
function rewardToSnbt(reward, seed, index) {
    const id = questId(`${seed}:reward:${index}`);
    const base = { id, type: reward.type };
    switch (reward.type) {
        case 'item':
            base.item = { id: normalizeItemId(reward.item ?? '') };
            base.count = asLong(reward.count ?? 1);
            break;
        case 'xp':
            base.xp = Math.max(1, Math.trunc(reward.xp ?? 10));
            break;
        case 'xp_levels':
            base.xp_levels = Math.max(1, Math.trunc(reward.levels ?? reward.xp ?? 5));
            break;
        case 'loot':
            base.table_id = reward.tableId ?? seed;
            break;
        case 'command':
            base.command = reward.command ?? 'say 恭喜完成任务';
            base.silent = reward.silent === true;
            break;
        case 'stage':
            base.stage = reward.stage ?? 'stage_1';
            break;
        case 'toast':
            base.title = reward.title ?? '已完成';
            base.description = reward.subtitle ?? '';
            break;
        case 'choice':
        case 'random':
            base.table_id = questId(`${seed}:table:${index}`);
            base.entries = (reward.entries ?? []).map((entry, entryIndex) => ({
                ...rewardToSnbt({ ...entry, type: entry.type === 'choice' ? 'item' : entry.type }, `${seed}:entry`, entryIndex),
                weight: 1,
            }));
            break;
        default:
            throw new ModpackError('UNSUPPORTED_REWARD', `不支持的奖励类型：${String(reward.type)}`);
    }
    if (reward.title !== undefined)
        base.title = reward.title;
    return base;
}
function questToSnbt(quest, chapterSeed, index) {
    const id = quest.id !== undefined && quest.id !== '' ? quest.id : questId(`${chapterSeed}:quest:${quest.title}:${quest.x}:${quest.y}`);
    const description = quest.description ?? [];
    const body = {
        id,
        x: asDouble(quest.x),
        y: asDouble(quest.y),
        title: quest.title,
    };
    if (quest.subtitle !== undefined)
        body.subtitle = quest.subtitle;
    body.description = description.length === 0 ? [''] : description;
    if (quest.icon !== undefined)
        body.icon = { id: normalizeItemId(quest.icon) };
    body.tasks = quest.tasks.map((task, taskIndex) => taskToSnbt(task, `${chapterSeed}:${id}`, taskIndex));
    body.rewards = (quest.rewards ?? []).map((reward, rewardIndex) => rewardToSnbt(reward, `${chapterSeed}:${id}`, rewardIndex));
    body.dependencies = quest.dependencies ?? [];
    if (quest.size !== undefined)
        body.size = asDouble(quest.size);
    if (quest.shape !== undefined)
        body.shape = quest.shape;
    if (quest.optional === true)
        body.optional = true;
    if (quest.hidden === true)
        body.hidden = true;
    if (quest.invisible === true)
        body.invisible = true;
    if (quest.hideDependencyLines === true)
        body.hide_dependency_lines = true;
    if (quest.disableRewardScreenBlur === true)
        body.disable_reward_screen_blur = true;
    if (quest.tags !== undefined && quest.tags.length > 0)
        body.tags = quest.tags;
    body.can_repeat = false;
    body.lock_text = '';
    return body;
}
/** 渲染一个章节的 SNBT 文本。 */
export function renderChapterSnbt(chapter, groupId) {
    const chapterSeed = questId(`chapter:${chapter.title}`);
    const filename = chapter.filename ?? slugify(chapter.title, 'chapter');
    const quests = chapter.quests;
    const body = {
        id: chapter.id ?? questId(`chapter-id:${chapter.title}`),
        group: groupId,
        order_index: chapter.orderIndex ?? 0,
        filename,
        title: chapter.title,
    };
    if (chapter.subtitle !== undefined)
        body.subtitle = chapter.subtitle;
    body.icon = { id: normalizeItemId(chapter.icon ?? 'minecraft:book') };
    body.default_quest_shape = chapter.defaultQuestShape ?? '';
    body.default_reward_shape = '';
    body.quest_links = [];
    body.quests = quests.map((quest, index) => questToSnbt(quest, chapterSeed, index));
    return `${snbtLiteral(body)}\n`;
}
/** 渲染 chapter_groups.snbt。 */
export function renderChapterGroupsSnbt(groups) {
    return `${snbtLiteral({ chapter_groups: groups.map((group) => ({ id: group.id, title: group.title })) })}\n`;
}
/** 渲染 data.snbt。 */
export function renderDataSnbt(title) {
    return `${snbtLiteral({
        version: 1,
        title,
        description: '',
        'default_quest_shape': '',
        'default_reward_shape': '',
        'disable_gui': false,
        'drop_items_on_death': false,
        'show_lock_icons': true,
    })}\n`;
}
// ── 生成 ─────────────────────────────────────────────────────────────────────
function autoChainQuests(quests) {
    const ordered = [...quests].sort((a, b) => a.y - b.y || a.x - b.x);
    return ordered.map((quest, index) => {
        if (index === 0)
            return quest;
        const previous = ordered[index - 1];
        const previousId = previous.id ?? questId(`${previous.title}:${previous.x}:${previous.y}`);
        const dependencies = [...(quest.dependencies ?? [])];
        if (!dependencies.includes(previousId))
            dependencies.push(previousId);
        return { ...quest, dependencies };
    });
}
/**
 * 生成完整 FTB Quests 任务书到 packDir。
 * 写入 config/ftbquests/quests/ 下的章节、章节组与 data.snbt。
 */
export async function generateQuestBook(input) {
    const packDir = requireString(input.packDir, 'packDir');
    const title = requireString(input.title, 'title');
    if (input.chapters.length === 0) {
        throw new ModpackError('INVALID_ARGUMENT', '任务书至少需要一个章节');
    }
    const questsRoot = join(packDir, 'config', 'ftbquests', 'quests');
    const chaptersDir = join(questsRoot, 'chapters');
    const dryRun = input.dryRun === true;
    const overwrite = input.overwrite !== false;
    if (!dryRun)
        await ensureDir(chaptersDir);
    const warnings = [];
    const files = [];
    const questIndex = [];
    const groupIds = new Map();
    let questCount = 0;
    let taskCount = 0;
    let rewardCount = 0;
    const chapters = input.chapters.map((chapter, index) => {
        const groupTitle = chapter.group ?? '';
        if (groupTitle !== '' && !groupIds.has(groupTitle)) {
            groupIds.set(groupTitle, questId(`group:${groupTitle}`));
        }
        const quests = input.autoChain === true ? autoChainQuests(chapter.quests) : chapter.quests;
        for (const quest of quests) {
            const id = quest.id ?? questId(`${questId(`chapter:${chapter.title}`)}:quest:${quest.title}:${quest.x}:${quest.y}`);
            questIndex.push({ id, chapter: chapter.title, title: quest.title });
            if (quest.tasks.length === 0)
                warnings.push(`任务「${quest.title}」没有任何目标（tasks 为空），运行时不可完成`);
        }
        return { ...chapter, orderIndex: chapter.orderIndex ?? index, quests };
    });
    for (const chapter of chapters) {
        const groupTitle = chapter.group ?? '';
        const groupId = groupTitle === '' ? '' : groupIds.get(groupTitle);
        const filename = chapter.filename ?? slugify(chapter.title, `chapter_${chapter.orderIndex ?? 0}`);
        const text = renderChapterSnbt({ ...chapter, filename }, groupId);
        const absolute = join(chaptersDir, `${filename}.snbt`);
        if (!dryRun && (overwrite || !(await pathExists(absolute)))) {
            await writeFileEnsured(absolute, text);
        }
        files.push(`config/ftbquests/quests/chapters/${filename}.snbt`);
        questCount += chapter.quests.length;
        for (const quest of chapter.quests) {
            taskCount += quest.tasks.length;
            rewardCount += quest.rewards?.length ?? 0;
        }
    }
    const groups = [...groupIds].map(([groupTitle, id]) => ({ id, title: groupTitle }));
    if (!dryRun) {
        await writeFileEnsured(join(questsRoot, 'chapter_groups.snbt'), renderChapterGroupsSnbt(groups));
    }
    files.push('config/ftbquests/quests/chapter_groups.snbt');
    if (!dryRun) {
        await writeFileEnsured(join(questsRoot, 'data.snbt'), renderDataSnbt(title));
    }
    files.push('config/ftbquests/quests/data.snbt');
    const seenIds = new Set();
    for (const entry of questIndex) {
        if (seenIds.has(entry.id))
            warnings.push(`任务 id 冲突：${entry.id}（来自「${entry.title}」），请显式指定 id`);
        seenIds.add(entry.id);
    }
    const knownIds = new Set(questIndex.map((entry) => entry.id));
    for (const chapter of chapters) {
        for (const quest of chapter.quests) {
            for (const dependency of quest.dependencies ?? []) {
                if (!knownIds.has(dependency)) {
                    warnings.push(`任务「${quest.title}」依赖了不存在的任务 id：${dependency}`);
                }
            }
        }
    }
    return {
        files,
        chapters: chapters.length,
        quests: questCount,
        tasks: taskCount,
        rewards: rewardCount,
        chapterGroups: groups.length,
        questIndex,
        warnings,
        createdAt: nowIso(),
    };
}
/** 任务书章节草稿的最小校验（供测试与工具参数自检）。 */
export function validateChapterDraft(chapter) {
    const problems = [];
    if (typeof chapter.title !== 'string' || chapter.title.trim() === '')
        problems.push('章节缺少 title');
    if (!Array.isArray(chapter.quests) || chapter.quests.length === 0)
        problems.push(`章节「${chapter.title}」没有任何任务`);
    for (const quest of chapter.quests ?? []) {
        if (typeof quest.title !== 'string' || quest.title.trim() === '')
            problems.push('存在没有 title 的任务');
        if (!Array.isArray(quest.tasks) || quest.tasks.length === 0)
            problems.push(`任务「${quest.title}」缺少 tasks`);
        if (!Number.isFinite(quest.x) || !Number.isFinite(quest.y))
            problems.push(`任务「${quest.title}」的 x/y 不是有限数字`);
    }
    return problems;
}
/** 归一化坐标，避免任务重叠（同一格重复时向右平移）。 */
export function dedupeQuestPositions(quests, step = 2) {
    const occupied = new Set();
    return quests.map((quest) => {
        let x = Math.trunc(quest.x);
        const y = Math.trunc(quest.y);
        while (occupied.has(`${x}:${y}`))
            x += step;
        occupied.add(`${x}:${y}`);
        return { ...quest, x, y };
    });
}
/** 依据任务规模给出建议的章节大小（供 UI/排版使用）。 */
export function suggestQuestSize(quest) {
    const complexity = quest.tasks.length + (quest.rewards?.length ?? 0) + (quest.dependencies?.length ?? 0);
    return clampInt(1 + complexity * 0.25, 1, 3, 1);
}
//# sourceMappingURL=quest-gen.js.map