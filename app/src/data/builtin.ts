import { BUILTIN_ASSETS_VERSION } from '../config';
import type { AssetEntry, AssetFamily, AssetKind, ProceduralKey, RuntimeCatalog } from './types';
import { defaultSizeFor } from './size';

interface FamilyMeta {
  displayName: string;
  kind: AssetKind;
  note: string;
}

const FAMILY_META: Record<string, FamilyMeta> = {
  tulip: {
    displayName: '郁金香',
    kind: 'main',
    note: '杯形的花头，最适合当主花',
  },
  rose: {
    displayName: '玫瑰',
    kind: 'main',
    note: '花瓣层层打开，适合放在视觉中心',
  },
  eucalyptus: {
    displayName: '尤加利',
    kind: 'greenery',
    note: '细碎的圆叶，让整束更透气',
  },
};

function entry(
  assetId: string,
  family: string,
  displayName: string,
  variantName: string,
  color: string,
  procedural: ProceduralKey,
  kind: AssetKind,
): AssetEntry {
  return {
    assetId,
    family,
    kind,
    displayName,
    familyName: FAMILY_META[family]?.displayName ?? displayName,
    variantName,
    color,
    procedural,
    size: defaultSizeFor(procedural),
    source: 'builtin',
  };
}

/** 没有真实资产清单时的内置程序化花材。assetId 刻意与 manifest 约定同名，方便以后平滑换真花。 */
export function buildBuiltinEntries(): AssetEntry[] {
  return [
    ...extensionEntries(),
    ...buildV07Entries(),
    entry('tulip-pink', 'tulip', '粉色郁金香', '粉', '#e8a4ba', 'tulip', 'main'),
    entry('tulip-cream', 'tulip', '奶白郁金香', '奶白', '#f2e2cb', 'tulip', 'main'),
    entry('tulip-rose', 'tulip', '玫红郁金香', '玫红', '#c95f80', 'tulip', 'main'),
    entry('tulip-butter', 'tulip', '鹅黄郁金香', '鹅黄', '#e9bc4f', 'tulip', 'main'),
    entry('rose-pink', 'rose', '粉色玫瑰', '粉', '#e79fb1', 'rose', 'main'),
    entry('rose-ivory', 'rose', '象牙白玫瑰', '象牙白', '#f0e0d2', 'rose', 'main'),
    entry('rose-red', 'rose', '深红玫瑰', '深红', '#b8425f', 'rose', 'main'),
    entry('eucalyptus-green', 'eucalyptus', '尤加利绿叶', '绿', '#9db08f', 'eucalyptus', 'greenery'),
    entry('eucalyptus-silver', 'eucalyptus', '银叶尤加利', '银绿', '#b9c4b3', 'eucalyptus', 'greenery'),
    entry('eucalyptus-deep', 'eucalyptus', '深绿尤加利', '深绿', '#6f8e6b', 'eucalyptus', 'greenery'),
  ];
}

export function buildBuiltinCatalog(): RuntimeCatalog {
  const entries = buildBuiltinEntries();
  const families: AssetFamily[] = [];
  for (const asset of entries) {
    const meta = familyMeta(asset.family);
    let family = families.find((f) => f.family === asset.family);
    if (!family) {
      family = {
        family: asset.family,
        displayName: meta?.displayName ?? asset.familyName,
        kind: asset.kind,
        note: meta?.note ?? '',
        entries: [],
      };
      families.push(family);
    }
    family.entries.push(asset);
  }
  return {
    mode: 'builtin',
    assetsVersion: BUILTIN_ASSETS_VERSION,
    entries,
    entriesById: Object.fromEntries(entries.map((e) => [e.assetId, e])),
    families,
  };
}

export function extensionEntries():AssetEntry[]{return [
entry('spray-rose-pink','spray','多头玫瑰 · 莓粉','莓粉','#ce7896','spray','filler'),
entry('daisy-gold','daisy','非洲菊 · 杏黄','杏黄','#e7ae4b','daisy','main'),
entry('daisy-cream','daisy','非洲菊 · 奶白','奶白','#f5e7d0','daisy','main')
].map(e=>({...e,familyName:e.family==='spray'?'多头玫瑰':'非洲菊'}));}

// ---------- V0.7 §5：30 种花材清单 ----------
//
// 主花／配花／绿叶各 10 种。已有的玫瑰、郁金香、尤加利走 manifest 里的真实 GLB；
// 其余用程序化几何先立住形态与配色，等 Lux3D 精细模型到位后按同一份清单换模型，
// 不冒充已完成的精细素材（见 docs/v0.7-plan.md §5）。

interface SpeciesDef {
  family: string;
  key: ProceduralKey;
  name: string;
  kind: AssetKind;
  note: string;
  /** [颜色名, 色值]；绿叶通常只有一种。 */
  colors: readonly (readonly [string, string])[];
}

export const V07_SPECIES = [
  // ---- 主花 ----
  { family: 'peony', key: 'peony', name: '牡丹', kind: 'main', note: '层层大瓣，一团开在中心', colors: [['藕粉', '#e6a9bd'], ['象牙', '#f3e6d8']] },
  { family: 'herbaceous-peony', key: 'herbaceous-peony', name: '芍药', kind: 'main', note: '半开的杯，露出花心', colors: [['浅粉', '#f0b9c8'], ['玫粉', '#d97b96']] },
  { family: 'carnation', key: 'carnation', name: '康乃馨', kind: 'main', note: '细碎瓣缘，耐看的圆顶', colors: [['珊瑚粉', '#ef9f9a'], ['奶白', '#f6ece0']] },
  { family: 'lily', key: 'lily', name: '百合', kind: 'main', note: '六瓣外翻，有花蕊', colors: [['米白', '#f7f0e2'], ['淡粉', '#eec3cd']] },
  { family: 'sunflower', key: 'sunflower', name: '向日葵', kind: 'main', note: '花盘加一圈舌状瓣', colors: [['明黄', '#e8b437'], ['柠檬', '#f0cd5c']] },
  { family: 'dahlia', key: 'dahlia', name: '大丽花', kind: 'main', note: '多层尖瓣，规整的莲座', colors: [['酒红', '#b24a5e'], ['蜜桃', '#eda183']] },
  { family: 'calla', key: 'calla', name: '马蹄莲', kind: 'main', note: '单瓣漏斗，喉里有肉穗', colors: [['象牙', '#f4efe2'], ['深紫', '#6f5a7a']] },
  // ---- V16 §2 补充两种主花 ----
  // 2026-11-10 起两种都有真实 Lux3D GLB 并已进 manifest（taskId 5722956 / 5723543，各 20 积分），
  // 花材架与知识卡不再标「占位」；下面的程序化几何只在 GLB 加载失败时兜底。
  { family: 'hydrangea', key: 'hydrangea', name: '绣球', kind: 'main', note: '圆顶花球，一小朵一小朵挤在一起', colors: [['天蓝', '#a8bfd8'], ['藕粉', '#e3b8c6']] },
  { family: 'orchid', key: 'orchid', name: '蝴蝶兰', kind: 'main', note: '平展的三瓣花，像停着的蝴蝶', colors: [['白', '#f4efe9'], ['紫', '#cdb9dc']] },
  // ---- 配花 ----
  { family: 'lisianthus', key: 'lisianthus', name: '洋桔梗', kind: 'filler', note: '叠瓣成杯，补中间的空', colors: [['浅紫', '#cdb9dc'], ['白', '#f4efe9']] },
  { family: 'alstroemeria', key: 'alstroemeria', name: '六出花', kind: 'filler', note: '漏斗小花成簇，带斑点', colors: [['粉橘', '#eaa07a'], ['淡粉', '#f2c4cf']] },
  { family: 'spray-chrysanthemum', key: 'spray-chrysanthemum', name: '多头小菊', kind: 'filler', note: '三个小头，把边缘填满', colors: [['鹅黄', '#efd27a'], ['白', '#f5f1e6']] },
  { family: 'babys-breath', key: 'babys-breath', name: '满天星', kind: 'filler', note: '一把小点，让画面透气', colors: [['白', '#f7f4ec'], ['淡粉', '#f3d6dd']] },
  { family: 'statice', key: 'statice', name: '补血草', kind: 'filler', note: '纸质小花摊成平顶', colors: [['薰衣草紫', '#b9a3cf'], ['象牙', '#ece3d3']] },
  { family: 'waxflower', key: 'waxflower', name: '澳洲蜡花', kind: 'filler', note: '星形小蜡花带圆苞', colors: [['淡粉', '#efc9d3'], ['玫红', '#d97f96']] },
  { family: 'rice-flower', key: 'rice-flower', name: '小米花', kind: 'filler', note: '小米粒一样的小球串', colors: [['米白', '#f0ead9'], ['浅绿', '#dfe6d2']] },
  { family: 'veronica', key: 'veronica', name: '婆婆纳', kind: 'filler', note: '细长花穗，拉高线条', colors: [['蓝紫', '#8fa6d4'], ['白', '#eef0f5']] },
  { family: 'snapdragon', key: 'snapdragon', name: '金鱼草', kind: 'filler', note: '总状花序，一朵朵往上开', colors: [['桃红', '#e88e9e'], ['鹅黄', '#ecc95f']] },
  // ---- 绿叶 ----
  { family: 'ruscus', key: 'ruscus', name: '鲁斯卡斯', kind: 'greenery', note: '卵形假叶，偏硬的质感', colors: [['深绿', '#4b6b45']] },
  { family: 'salal', key: 'salal', name: '沙柳叶', kind: 'greenery', note: '大叶革质，托住整束', colors: [['中绿', '#5d7d4f']] },
  { family: 'asparagus-fern', key: 'asparagus-fern', name: '文竹', kind: 'greenery', note: '细羽状针叶，轻盈', colors: [['浅绿', '#8fae7f']] },
  { family: 'leatherleaf', key: 'leatherleaf', name: '皮革蕨', kind: 'greenery', note: '长椭圆革质叶带锯齿', colors: [['灰绿', '#6f8a63']] },
  { family: 'boston-fern', key: 'boston-fern', name: '肾蕨', kind: 'greenery', note: '羽状复叶，小叶密集', colors: [['亮绿', '#5b7f4a']] },
  { family: 'ivy', key: 'ivy', name: '常春藤', kind: 'greenery', note: '三裂心形叶，藤蔓垂下', colors: [['深绿', '#46653f']] },
  { family: 'fatsia', key: 'fatsia', name: '八角金盘', kind: 'greenery', note: '掌状大叶，很有存在感', colors: [['墨绿', '#3f5c3a']] },
  { family: 'aspidistra', key: 'aspidistra', name: '蜘蛛抱蛋叶', kind: 'greenery', note: '长带状单叶，立得住', colors: [['深绿', '#3d5a38']] },
  { family: 'bear-grass', key: 'bear-grass', name: '熊草', kind: 'greenery', note: '细长草叶，向外散开', colors: [['银绿', '#93a98a']] },
] as const satisfies readonly SpeciesDef[];

// ---------- 编译期一致性：ProceduralKey 与花材清单同源 ----------
//
// 30 花型的正式集合 = `V07_SPECIES` 的 25 个 key + 5 个既有花型 key。
// 若 `types.ts` 的 `PROCEDURAL_KEYS` 多写或少写了花型，下面的断言会让
// `tsc` 直接失败（类型退化成 never），而不是等到运行时把花材误判成占位花。
type BuiltinExtraKey = 'tulip' | 'rose' | 'eucalyptus' | 'spray' | 'daisy';
type OrphanProceduralKeys = Exclude<
  ProceduralKey,
  (typeof V07_SPECIES)[number]['key'] | BuiltinExtraKey
>;
export const PROCEDURAL_KEYS_MATCH_SPECIES: [OrphanProceduralKeys] extends [never] ? true : never =
  true;

/** 一个配色一个条目：assetId 用「花科-序号」，显示名统一「花名 · 颜色」。 */
function speciesEntries(): AssetEntry[] {
  const entries: AssetEntry[] = [];
  for (const species of V07_SPECIES) {
    species.colors.forEach(([variantName, color], index) => {
      entries.push({
        assetId: `${species.family}-${index + 1}`,
        family: species.family,
        kind: species.kind,
        displayName: `${species.name} · ${variantName}`,
        familyName: species.name,
        variantName,
        color,
        procedural: species.key,
        size: defaultSizeFor(species.key),
        source: 'builtin',
      });
    });
  }
  return entries;
}

/** 30 种花材的目录条目（含已有花型之外的 25 种新几何）。 */
export function buildV07Entries(): AssetEntry[] {
  return speciesEntries();
}

/** 花科的中文名与一句说明；真实清单与内置目录共用。 */
export function familyMeta(family: string): FamilyMeta | undefined {
  const species = V07_SPECIES.find((item) => item.family === family);
  if (species) return { displayName: species.name, kind: species.kind, note: species.note };
  if (family === 'spray') return { displayName: '多头玫瑰', kind: 'filler', note: '一枝多头的玫瑰，插在花与花之间' };
  if (family === 'daisy') return { displayName: '非洲菊', kind: 'main', note: '平展的一轮花瓣，颜色明快' };
  return FAMILY_META[family];
}
