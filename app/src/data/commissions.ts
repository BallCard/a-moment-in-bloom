/**
 * 六封短委托：内容写死在前端，判定只用明确条件（花材、颜色、包装、器型、卡片），
 * 不做审美评分、不加倒计时。
 *
 * c1–c3 用纸包花束与首批真实花材；c4–c6 跟着 V0.7/V10 的花材与器型扩充，
 * 分别引导「花篮 + 向日葵」「陶罐 + 真绿叶」「礼盒 + 吊牌」三种新做法。
 * V16 §5：委托条件与包装能力表保持一致——只有纸包要求可编辑丝带，
 * 花礼盒的缎带是模型的一部分，改成实际可加的吊牌。
 *
 * 解锁：C1 默认可接；之后每一封都要前一封交付后才解锁。已完成的委托仍可重做。
 */

import type {
  AssetKind,
  BouquetDocument,
  CommissionCheck,
  CommissionCheckResult,
  CommissionDef,
  CommissionProgress,
  OrnamentKind,
  RuntimeCatalog,
} from './types';
import type { PresentationKind } from './presentation';
import { supportsRibbon } from './decor-capability';

export const COMMISSIONS: CommissionDef[] = [
  {
    id: 'c1-birthday',
    order: 1,
    title: '给妈妈的生日花',
    customer: '林女士',
    occasion: '生日 · 餐桌',
    brief: '妈妈喜欢柔和的粉，不要太多。想摆在餐桌上，看着像清晨。',
    accent: '#d59aa8',
    checks: [
      { id: 'c1-main', label: '粉色主花至少 3 枝（玫瑰或郁金香）', kind: 'kindCount', assetKind: 'main', assetIds: ['rose-pink', 'tulip-pink'], min: 3 },
      { id: 'c1-leaf', label: '尤加利至少 1 枝', kind: 'familyCount', family: 'eucalyptus', min: 1 },
      { id: 'c1-paper', label: '用暖白纸包好', kind: 'paper', paperId: 'ivory' },
      { id: 'c1-card', label: '卡片正文至少 4 个字', kind: 'cardMessage', min: 4 },
    ],
    responseComplete:
      '妈妈把花放在餐桌上，说屋子一下亮了起来。她还把那张小卡片留在了窗边。',
    responsePartial:
      '妈妈收下了这份心意。林女士想再一起看看，还有哪一点可以更贴近原来的心愿。',
    nextId: 'c2-new-home',
  },
  {
    id: 'c2-new-home',
    order: 2,
    title: '搬新家的那束',
    customer: '阿澈',
    occasion: '乔迁 · 玄关',
    brief: '新家是木色和灰绿。不用天天打理的那种，放在玄关就好。',
    accent: '#8f9f86',
    checks: [
      { id: 'c2-total', label: '至少 5 枝花', kind: 'totalCount', min: 5 },
      { id: 'c2-leaf', label: '尤加利至少 2 枝', kind: 'familyCount', family: 'eucalyptus', min: 2 },
      { id: 'c2-paper', label: '用牛皮纸包好', kind: 'paper', paperId: 'kraft' },
      { id: 'c2-ribbon', label: '系灰绿丝带', kind: 'ribbon', ribbonColorId: 'sage' },
    ],
    responseComplete:
      '阿澈把花放在玄关的旧木凳上，颜色刚好接住那面灰绿的墙。',
    responsePartial:
      '阿澈收下了这束花，也想再对照来信，把剩下的小心愿补齐。',
    nextId: 'c3-anniversary',
  },
  {
    id: 'c3-anniversary',
    order: 3,
    title: '纪念日的告白',
    customer: '小满',
    occasion: '纪念日 · 告白',
    brief: '想送一束粉玫瑰，要有层次，别太满。卡片我自己写。',
    accent: '#c98a9b',
    checks: [
      { id: 'c3-rose', label: '粉色玫瑰至少 3 枝', kind: 'assetCount', assetId: 'rose-pink', min: 3 },
      { id: 'c3-tulip', label: '郁金香至少 1 枝', kind: 'familyCount', family: 'tulip', min: 1 },
      { id: 'c3-ribbon', label: '系玫瑰色丝带', kind: 'ribbon', ribbonColorId: 'rose' },
      { id: 'c3-to', label: '卡片写上收件人', kind: 'cardTo', min: 1 },
      { id: 'c3-message', label: '卡片正文至少 4 个字', kind: 'cardMessage', min: 4 },
    ],
    responseComplete:
      '她读完卡片，把花抱在怀里笑了一下。那天晚上，桌上一直亮着一盏小灯。',
    responsePartial:
      '小满说谢谢，也希望下一次能把来信里的小心愿都留在花束里。',
    nextId: 'c4-sunflower-basket',
  },
  {
    id: 'c4-sunflower-basket',
    order: 4,
    title: '店门口的那篮太阳花',
    customer: '老潘',
    occasion: '开业 · 店门口',
    brief:
      '我开了间小面馆，想把花摆在门口。想要太阳花，亮一点的，别插得太规整，像随手放的就好。配花你看着加两枝，热闹些。',
    accent: '#d8a13f',
    checks: [
      { id: 'c4-basket', label: '用藤编花篮装好', kind: 'presentation', presentationKind: 'basket' },
      { id: 'c4-sunflower', label: '向日葵至少 2 枝', kind: 'familyCount', family: 'sunflower', min: 2 },
      { id: 'c4-filler', label: '配花至少 2 枝（小菊或补血草）', kind: 'kindCount', assetKind: 'filler', min: 2 },
      { id: 'c4-total', label: '整束至少 5 枝', kind: 'totalCount', min: 5 },
    ],
    responseComplete:
      '老潘把花篮放在门口第一张桌上，太阳花朝着街面。进来的客人总要问一句，这花是在哪儿订的。',
    responsePartial:
      '老潘收下了花篮，说颜色是对的，就是心愿里那几条还想再对一对。',
    nextId: 'c5-new-home-pot',
  },
  {
    id: 'c5-new-home-pot',
    order: 5,
    title: '朝北窗台上的陶罐',
    customer: '沈岚',
    occasion: '乔迁 · 窗台',
    brief:
      '换了间朝北的小房子，窗台空着。想要一个旧陶罐，插些真叶子，绿得深一点；主花一两枝就够，不用满。卡片可写可不写，一句话就好。',
    accent: '#8a7a5c',
    checks: [
      { id: 'c5-pot', label: '用宽口陶罐插好', kind: 'presentation', presentationKind: 'pot' },
      { id: 'c5-main', label: '主花至少 1 枝', kind: 'kindCount', assetKind: 'main', min: 1 },
      { id: 'c5-green', label: '真绿叶至少 3 枝', kind: 'kindCount', assetKind: 'greenery', min: 3 },
      { id: 'c5-ruscus', label: '鲁斯卡斯至少 1 枝', kind: 'familyCount', family: 'ruscus', min: 1 },
      { id: 'c5-total', label: '整束至少 5 枝', kind: 'totalCount', min: 5 },
    ],
    responseComplete:
      '沈岚把陶罐放在窗台上，说北窗终于有了点活气。过了两天她拍来照片，叶子还是深绿的。',
    responsePartial:
      '沈岚把陶罐收下了，说方向是对的，只是心愿里那几样还想再核对一遍。',
    nextId: 'c6-anniversary-box',
  },
  {
    id: 'c6-anniversary-box',
    order: 6,
    title: '第八年的礼盒',
    customer: '顾先生',
    occasion: '纪念日 · 礼盒',
    brief:
      '结婚第八年，想送一盒花。她喜欢玫瑰和郁金香，别用大红。盒子自带的玫瑰色缎带已经很正，就别再动了；你在盒边挂一张小吊牌，把我写好的句子誊到卡片上。',
    accent: '#b97a86',
    checks: [
      { id: 'c6-box', label: '用花礼盒装好', kind: 'presentation', presentationKind: 'box' },
      { id: 'c6-rose', label: '玫瑰至少 2 枝', kind: 'familyCount', family: 'rose', min: 2 },
      { id: 'c6-tulip', label: '郁金香至少 2 枝', kind: 'familyCount', family: 'tulip', min: 2 },
      // V16 §5：礼盒自带缎带是模型的一部分，委托不再要求「可编辑丝带」；
      // 改成礼盒实际支持的装饰——挂一张吊牌。
      { id: 'c6-tag', label: '挂一张吊牌', kind: 'ornament', ornamentKind: 'tag' },
      { id: 'c6-message', label: '卡片正文至少 4 个字', kind: 'cardMessage', min: 4 },
    ],
    responseComplete:
      '顾先生把盒子递过去时，缎带还系得很正。她说今年这个比戒指盒好看，然后一直没舍得拆。',
    responsePartial:
      '顾先生收下了礼盒，说已经很像样了，还想再对照信里的话检查一遍。',
    nextId: null,
  },
];

const BY_ID: Record<string, CommissionDef> = Object.fromEntries(
  COMMISSIONS.map((def) => [def.id, def]),
);

export function getCommission(id: string | null): CommissionDef | null {
  if (!id) return null;
  return BY_ID[id] ?? null;
}

function countStems(doc: BouquetDocument, predicate: (assetId: string) => boolean): number {
  return doc.stems.reduce((total, stem) => (predicate(stem.assetId) ? total + 1 : total), 0);
}

function charCount(value: string): number {
  return Array.from(value.trim()).length;
}

function checkOne(doc: BouquetDocument, catalog: RuntimeCatalog, check: CommissionCheck): boolean {
  switch (check.kind) {
    case 'kindCount': {
      if (!check.assetKind) return false;
      const min = check.min ?? 1;
      return (
        countStems(
          doc,
          (assetId) => catalog.entriesById[assetId]?.kind === check.assetKind && (!check.assetIds || check.assetIds.includes(assetId)),
        ) >= min
      );
    }
    case 'assetCount': {
      if (!check.assetId) return false;
      const min = check.min ?? 1;
      return countStems(doc, (assetId) => assetId === check.assetId) >= min;
    }
    case 'familyCount': {
      if (!check.family) return false;
      const min = check.min ?? 1;
      return (
        countStems(
          doc,
          (assetId) => catalog.entriesById[assetId]?.family === check.family,
        ) >= min
      );
    }
    case 'totalCount':
      return doc.stems.length >= (check.min ?? 1);
    case 'paper':
      return doc.presentation.kind === 'paper' && doc.wrapping.enabled && doc.wrapping.step !== 'paper' && doc.presentation.sheets.some(sheet => sheet.paperId === check.paperId);
    case 'ribbon':
      // V16 §5：只有纸包有真正可编辑的丝带。委托的丝带条件只在支持可编辑丝带的
      // 形态下成立，不再为花礼盒的「模型自带缎带」开后门（那不可换色、也不该被当成可满足条件）。
      return (
        supportsRibbon(doc.presentation.kind) &&
        doc.ribbon.colorId === check.ribbonColorId &&
        doc.wrapping.enabled &&
        ['ribbon', 'card'].includes(doc.wrapping.step)
      );
    case 'ornament':
      // V16 §5：委托要求实际支持该形态的装饰（如礼盒的吊牌），未添加即不成立。
      // 旧存档没有 ornaments 字段时按空列表处理，不抛错。
      return Boolean(check.ornamentKind) && (doc.ornaments ?? []).some((item) => item.kind === check.ornamentKind);
    case 'cardTo':
      return charCount(doc.card.to) >= (check.min ?? 1);
    case 'cardMessage':
      return charCount(doc.card.message) >= (check.min ?? 1);
    case 'presentation':
      return Boolean(check.presentationKind) && doc.presentation.kind === check.presentationKind;
    default:
      return false;
  }
}

/**
 * 委托心愿里「值得在花材架上标出来」的花材与形态。
 *
 * 花材架只读取这份派生结果，不再各自理解 CommissionCheck：
 * - families：同科不同配色都算（familyCount）；
 * - assetIds：明确点名的配色（assetCount / kindCount 的 assetIds）；
 * - kinds：只说了角色（kindCount 没点名配色）时，整类都算候选；
 * - paperId / ribbonColorId / presentationKind / ornamentKind：包装、器型与装饰的提示点。
 */
export interface CommissionWish {
  families: string[];
  assetIds: string[];
  kinds: AssetKind[];
  paperId?: string;
  ribbonColorId?: string;
  presentationKind?: PresentationKind;
  ornamentKind?: OrnamentKind;
}

export function commissionWishes(commissionId: string | null): CommissionWish | null {
  const def = getCommission(commissionId);
  if (!def) return null;
  const wish: CommissionWish = { families: [], assetIds: [], kinds: [] };
  for (const check of def.checks) {
    if (check.kind === 'familyCount' && check.family) wish.families.push(check.family);
    if (check.kind === 'assetCount' && check.assetId) wish.assetIds.push(check.assetId);
    if (check.kind === 'kindCount') {
      if (check.assetIds?.length) wish.assetIds.push(...check.assetIds);
      else if (check.assetKind) wish.kinds.push(check.assetKind);
    }
    if (check.kind === 'paper' && check.paperId) wish.paperId = check.paperId;
    if (check.kind === 'ribbon' && check.ribbonColorId) wish.ribbonColorId = check.ribbonColorId;
    if (check.kind === 'ornament' && check.ornamentKind) wish.ornamentKind = check.ornamentKind;
    if (check.kind === 'presentation' && check.presentationKind) {
      wish.presentationKind = check.presentationKind;
    }
  }
  wish.families = [...new Set(wish.families)];
  wish.assetIds = [...new Set(wish.assetIds)];
  wish.kinds = [...new Set(wish.kinds)];
  return wish;
}

/** 纯函数：逐条判定当前作品是否满足委托要求。 */
export function evaluateCommission(
  doc: BouquetDocument,
  def: CommissionDef,
  catalog: RuntimeCatalog,
): CommissionProgress {
  const checks: CommissionCheckResult[] = def.checks.map((check) => ({
    id: check.id,
    label: check.label,
    met: checkOne(doc, catalog, check),
  }));
  const metCount = checks.filter((check) => check.met).length;
  return {
    commissionId: def.id,
    checks,
    complete: metCount === checks.length,
    metCount,
    total: checks.length,
  };
}

export function isCommissionUnlocked(def: CommissionDef, completedIds: string[]): boolean {
  const index = COMMISSIONS.findIndex((item) => item.id === def.id);
  if (index <= 0) return true;
  const previous = COMMISSIONS[index - 1];
  return completedIds.includes(previous.id);
}

/** 下一张可接的委托：未完成且已解锁；都做完了返回 null。 */
export function firstAvailableCommission(completedIds: string[]): CommissionDef | null {
  for (const def of COMMISSIONS) {
    if (!completedIds.includes(def.id) && isCommissionUnlocked(def, completedIds)) return def;
  }
  return null;
}

/** 交付后要展示的「后续委托」：优先委托自带的 nextId，否则按解锁链找下一张。 */
export function nextCommissionAfter(def: CommissionDef, completedIds: string[]): CommissionDef | null {
  const declared = getCommission(def.nextId);
  if (declared && !completedIds.includes(declared.id)) return declared;
  return firstAvailableCommission(completedIds);
}
