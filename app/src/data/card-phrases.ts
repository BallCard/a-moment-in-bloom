/**
 * 贺卡常用短语（V16 §7）。
 *
 * 只放静态文案，不依赖 React 与 Three.js；界面按场合分组展示，点一下插入正文。
 * 约束：
 * - 每条都在 CARD_MESSAGE_MAX 以内，插入后还能继续编辑；
 * - 不写具体人名、关系、经历等需要用户自己确认的内容，避免替用户编造；
 * - 场合标签用「生日 / 感谢 / 纪念日 / 日常惦记」，数量适中（每类 3 条）。
 */

import { CARD_MESSAGE_MAX } from '../config';
import { clampText } from './decor';

export type CardPhraseOccasion = 'birthday' | 'thanks' | 'anniversary' | 'daily';

export interface CardPhraseGroup {
  id: CardPhraseOccasion;
  label: string;
  /** 一句说明，界面直接用。 */
  hint: string;
  phrases: string[];
}

export const CARD_PHRASE_GROUPS: CardPhraseGroup[] = [
  {
    id: 'birthday',
    label: '生日',
    hint: '把祝福说具体一点',
    phrases: [
      '生日快乐，愿你这一年都被温柔对待。',
      '又长一岁，想把今天的花都送给你。',
      '愿新的一岁，烦恼少一点，喜欢多一点。',
    ],
  },
  {
    id: 'thanks',
    label: '感谢',
    hint: '谢谢不必说得很大声',
    phrases: [
      '谢谢你一直在，很多小事都记在心里。',
      '这一束花，替我说一句谢谢。',
      '辛苦了，谢谢你为这件事花的时间。',
    ],
  },
  {
    id: 'anniversary',
    label: '纪念日',
    hint: '留给一起走过的日子',
    phrases: [
      '纪念日快乐，谢谢你陪我走这一段。',
      '把这些日子收进一束花里，慢慢看。',
      '又一年了，想和你继续这样过下去。',
    ],
  },
  {
    id: 'daily',
    label: '日常惦记',
    hint: '没有由头也可以送花',
    phrases: [
      '路过花店想到你，就带了一束来。',
      '没什么事，只是想让你今天心情好一点。',
      '看到这朵花的时候，想到的是你。',
    ],
  },
];

/** 插入后仍要满足正文上限：返回 false 说明这条短语加进去会超字数。 */
export function fitsWithCurrent(current: string, phrase: string): boolean {
  return Array.from(appendPhrase(current, phrase)).length <= CARD_MESSAGE_MAX;
}

/**
 * 把短语追加到已有正文后面：空正文直接就是短语；非空时补一个空格，
 * 免得两句粘在一起。返回值已经按上限截断。
 */
export function appendPhrase(current: string, phrase: string): string {
  const base = current.trim();
  const text = base ? `${base} ${phrase}` : phrase;
  return clampText(text, CARD_MESSAGE_MAX);
}

/** 界面提示用：这条短语插进去会不会替换掉已有正文。 */
export function phraseReplacesMessage(current: string): boolean {
  return current.trim().length > 0;
}
