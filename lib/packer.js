/**
 * dsh-tool-modpack — 打包器（mrpak / CurseForge zip / 手动整包 zip）。
 *
 * 自包含实现：zip 读写只用 node:zlib 的 raw deflate，不引入任何压缩库。
 * 因此 packer.ts 也是"资源包 zip""UI 材质包 zip"共用的底层。
 *
 * mrpak 格式（本插件定义，v1）：
 *   mrpak.json      清单：文件名、体积、sha256、模组列表、加载器、覆盖目录
 *   mods/*.jar      版本文件（可由清单按 sha1 校验）
 *   manifest.json   CurseForge 兼容清单（可被 CF 启动器识别时生成）
 *   overrides/      配置覆盖目录
 *   其余目录        config/ resourcepacks/ shaderpacks/ kubejs/ ftbquests/ packmenu/ …
 *
 * @module dsh-tool-modpack/packer
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { ModpackError, crc32, ensureDir, nowIso, sha256, toPosix, writeFileEnsured } from './util.js';
function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}
/** 把一组条目打成 zip（返回完整字节）。 */
export function buildZip(entries, options = {}) {
    const stamp = dosDateTime(options.date ?? new Date());
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const nameBuf = Buffer.from(toPosix(entry.path), 'utf8');
        const raw = Buffer.from(entry.data);
        const useDeflate = entry.compress ?? options.compress ?? true;
        const deflated = useDeflate ? deflateRawSync(raw, { level: 9 }) : raw;
        const useStored = !useDeflate || deflated.length >= raw.length;
        const payload = useStored ? raw : deflated;
        const method = useStored ? 0 : 8;
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // UTF-8 flag
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(stamp.time, 10);
        local.writeUInt16LE(stamp.date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBuf, payload);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(stamp.time, 12);
        central.writeUInt16LE(stamp.date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // disk
        central.writeUInt16LE(0, 36); // internal attrs
        central.writeUInt32LE(0, 38); // external attrs
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + payload.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, centralBuf, eocd]);
}
/** 读取 zip 内的条目（解析中央目录，仅支持 store/deflate，覆盖 99% 的资源包与整合包）。 */
export function readZip(buffer) {
    const buf = Buffer.from(buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new ModpackError('ZIP_INVALID', '不是合法的 zip：找不到 EOCD 记录');
    const total = buf.readUInt16LE(eocd + 10);
    let pointer = buf.readUInt32LE(eocd + 16);
    const out = [];
    for (let i = 0; i < total; i++) {
        if (buf.readUInt32LE(pointer) !== 0x02014b50) {
            throw new ModpackError('ZIP_INVALID', `zip 中央目录第 ${i} 条记录签名错误`);
        }
        const method = buf.readUInt16LE(pointer + 10);
        const compressedSize = buf.readUInt32LE(pointer + 20);
        const uncompressedSize = buf.readUInt32LE(pointer + 24);
        const nameLength = buf.readUInt16LE(pointer + 28);
        const extraLength = buf.readUInt16LE(pointer + 30);
        const commentLength = buf.readUInt16LE(pointer + 32);
        const localOffset = buf.readUInt32LE(pointer + 42);
        const path = buf.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
        const localNameLength = buf.readUInt16LE(localOffset + 26);
        const localExtraLength = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const payload = buf.subarray(dataStart, dataStart + compressedSize);
        let data;
        if (method === 0)
            data = new Uint8Array(payload);
        else if (method === 8)
            data = new Uint8Array(inflateRawSync(payload));
        else
            throw new ModpackError('ZIP_UNSUPPORTED', `zip 条目 ${path} 使用了不支持的压缩方式 ${method}`);
        if (!path.endsWith('/')) {
            if (uncompressedSize !== 0 && data.byteLength !== uncompressedSize) {
                throw new ModpackError('ZIP_CORRUPT', `zip 条目 ${path} 长度不符（期望 ${uncompressedSize}，实际 ${data.byteLength}）`);
            }
            out.push({ path, data });
        }
        pointer += 46 + nameLength + extraLength + commentLength;
    }
    return out;
}
/** 写 zip 到磁盘。 */
export async function writeZip(file, entries, options = {}) {
    await writeFileEnsured(file, buildZip(entries, options));
    return file;
}
const DEFAULT_EXCLUDE = [
    'logs',
    'crash-reports',
    'saves',
    'screenshots',
    'backups',
    'cache',
    'tmp',
    '.git',
    'node_modules',
    '.DS_Store',
    'thumbs.db',
];
function topSegment(relPath) {
    const posix = toPosix(relPath);
    const index = posix.indexOf('/');
    return index === -1 ? posix : posix.slice(0, index);
}
/** 递归收集目录下的文件（自动跳过日志、存档、缓存等噪声）。 */
export async function collectFiles(root, options = {}) {
    const include = options.include;
    const exclude = new Set([...DEFAULT_EXCLUDE, ...(options.exclude ?? [])].map((item) => item.toLowerCase()));
    const out = [];
    const maxBytes = options.maxFileBytes ?? 512 * 1024 * 1024;
    async function walk(dir) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const absolute = join(dir, entry.name);
            const rel = toPosix(relative(root, absolute));
            if (entry.isDirectory()) {
                if (exclude.has(entry.name.toLowerCase()))
                    continue;
                await walk(absolute);
                continue;
            }
            if (!entry.isFile())
                continue;
            const top = topSegment(rel);
            if (include !== undefined && !include.includes(top))
                continue;
            if (exclude.has(entry.name.toLowerCase()))
                continue;
            if (options.skipPattern !== undefined && options.skipPattern.test(rel))
                continue;
            const info = await stat(absolute);
            if (info.size > maxBytes)
                continue;
            out.push({ path: rel, absolute, size: info.size });
        }
    }
    await walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
}
/** 把收集到的文件读成 zip 条目。 */
export async function filesToZipEntries(files, transformPath) {
    const entries = [];
    for (const file of files) {
        const data = new Uint8Array(await readFile(file.absolute));
        entries.push({ path: transformPath === undefined ? file.path : transformPath(file.path), data });
    }
    return entries;
}
/** 默认打进整合包的目录。 */
export const DEFAULT_PACK_INCLUDE = [
    'mods',
    'config',
    'defaultconfigs',
    'kubejs',
    'scripts',
    'resourcepacks',
    'shaderpacks',
    'ftbquests',
    'packmenu',
    'polytone',
    'options.txt',
    'servers.dat',
    'icon.png',
    'README.md',
];
function uniqueSorted(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
async function collectPackContent(options) {
    const include = options.include ?? DEFAULT_PACK_INCLUDE;
    const outFilePosix = toPosix(options.outFile);
    const files = await collectFiles(options.packDir, {
        include,
        ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
    });
    const kept = files.filter((file) => toPosix(file.absolute) !== outFilePosix && basename(file.absolute) !== basename(options.outFile));
    return filesToZipEntries(kept);
}
function summarize(entries, format, path, notes) {
    const buffer = buildZip(entries);
    return {
        format,
        path,
        size: buffer.byteLength,
        sha256: sha256(buffer),
        entryCount: entries.length,
        entries: uniqueSorted(entries.map((entry) => entry.path)),
        notes,
    };
}
/** 导出 mrpak（自包含：清单 + 模组 + 覆盖目录 + CurseForge 兼容清单）。 */
export async function exportMrpak(options) {
    const notes = [];
    const content = await collectPackContent(options);
    const mods = options.mods ?? [];
    const manifest = {
        format: 'mrpak',
        formatVersion: 1,
        name: options.name,
        version: options.version,
        authors: options.authors ?? [],
        summary: options.summary ?? '',
        description: options.description ?? '',
        created: nowIso(),
        minecraft: {
            version: options.minecraftVersion,
            loader: options.loader,
            loaderVersion: options.loaderVersion ?? null,
        },
        files: content.map((entry) => ({
            path: entry.path,
            size: entry.data.byteLength,
            sha256: sha256(entry.data),
        })),
        mods,
        fileCount: content.length,
    };
    const entries = [
        {
            path: 'mrpak.json',
            data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
            compress: true,
        },
        ...content,
        await buildCurseForgeManifestEntry(options, notes),
    ];
    const result = summarize(entries, 'mrpak', options.outFile, notes);
    await writeFileEnsured(options.outFile, buildZip(entries, options.date !== undefined ? { date: options.date } : {}));
    return result;
}
async function buildCurseForgeManifestEntry(options, notes) {
    const overrides = options.overridesFolder ?? 'overrides';
    const files = [];
    for (const mod of options.mods ?? []) {
        const ids = options.curseforgeIds?.[mod.projectId] ?? options.curseforgeIds?.[mod.slug];
        if (ids !== undefined) {
            files.push({ projectID: ids.projectID, fileID: ids.fileID, required: mod.required });
        }
        else if (mod.required) {
            notes.push(`模组 ${mod.slug} 缺少 CurseForge 数字 id，已保留实体 jar，CF 启动器需手动导入`);
        }
    }
    const manifest = {
        minecraft: {
            version: options.minecraftVersion,
            modLoaders: [{ id: `${options.loader}-${options.loaderVersion ?? 'latest'}`, primary: true }],
        },
        manifestType: 'minecraftModpack',
        manifestVersion: 1,
        name: options.name,
        version: options.version,
        author: (options.authors ?? ['unknown'])[0] ?? 'unknown',
        files,
        overrides,
    };
    return {
        path: 'manifest.json',
        data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
        compress: true,
    };
}
/**
 * 导出 CurseForge 风格 zip：manifest.json + overrides/。
 * 有 CF 数字 id 时走标准 CF 格式；没有时保留 mods/ 实体文件并降级说明。
 */
export async function exportCurseForgeZip(options) {
    const notes = [];
    const overridesFolder = options.overridesFolder ?? 'overrides';
    const content = await collectPackContent(options);
    const entries = [await buildCurseForgeManifestEntry(options, notes)];
    const remap = new Set(['mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'ftbquests', 'packmenu', 'polytone']);
    for (const entry of content) {
        const top = topSegment(entry.path);
        // CurseForge 规范要求配置类内容放进 overrides/，其余（mods、resourcepacks）按需保留。
        const target = remap.has(top) ? `${overridesFolder}/${entry.path}` : entry.path;
        entries.push({ path: target, data: entry.data, ...(entry.compress !== undefined ? { compress: entry.compress } : {}) });
    }
    const result = summarize(entries, 'curseforge', options.outFile, notes);
    await writeFileEnsured(options.outFile, buildZip(entries, options.date !== undefined ? { date: options.date } : {}));
    return result;
}
/** 导出手动整包 zip（目录原样打包，供 PCL/HMCL/Prism 直接解压使用）。 */
export async function exportManualZip(options) {
    const notes = ['手动整包：直接解压到 .minecraft 即可使用，不需要启动器导入清单'];
    const content = await collectPackContent(options);
    const result = summarize(content, 'manual', options.outFile, notes);
    await writeFileEnsured(options.outFile, buildZip(content, options.date !== undefined ? { date: options.date } : {}));
    return result;
}
/** 按格式分发导出。 */
export async function exportPack(format, options) {
    await ensureDir(join(options.outFile, '..'));
    if (format === 'mrpak')
        return exportMrpak(options);
    if (format === 'curseforge')
        return exportCurseForgeZip(options);
    return exportManualZip(options);
}
//# sourceMappingURL=packer.js.map