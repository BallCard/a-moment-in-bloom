/**
 * 花材知识卡内容（V16 §4）。
 *
 * 口径（见 docs/flower-workflow-upgrade-plan.md §4）：
 * - 三节：认识它（名称 / 辨认特色 / 花语）、怎么搭（1–2 条）、照顾它（2–3 条）；
 * - 花语写「常见寓意」，不是统一标准；搭配写「可以怎样用」，不规定唯一配方；
 * - 养护只留最有用的几条，并区分**切花瓶插**与**活体种植/自然花期**；时长一律
 *   用有条件表述（「通常」「因品种与室温而异」），不写死具体天数；
 * - 来源如实登记：每条给出维基百科条目名 + URL + 核对日期（2026-11-10 实际访问
 *   返回 200），用于核对**学名、别名与基本形态**；养护建议是通用花艺整理，
 *   不是逐条引文，界面会同时显示 `KNOWLEDGE_CARE_NOTE`。没有可靠来源的条目
 *   必须显式写 `unverified: true`，不编造网址、不把程序化渲染图当实拍。
 *
 * 纯数据 + 纯函数，不依赖 React / Three.js。新增花型时在这里补一条即可，
 * 缺失时界面会显示「还没有整理这一种的知识」而不是空白。
 */

export interface KnowledgeSource {
  /** 展示给人看的来源名。 */
  name: string;
  url?: string;
  /** 核对日期（YYYY-MM-DD）。 */
  checkedAt: string;
  /** 这个来源具体用来核对什么，避免夸大「来源」的范围。 */
  note?: string;
}

export interface FlowerKnowledge {
  /** 花科 key，与 data/builtin.ts 的 family 一致。 */
  family: string;
  /** 展示名，与目录里的 familyName 对齐。 */
  displayName: string;
  /** 别名 / 常见商品名，可为空。 */
  aka?: string[];
  /** 认识它：辨认特色（一到两句，具体到能看出差别）。 */
  identify: string;
  /** 花语：常见寓意，明确不是统一标准。 */
  meaning: string;
  /** 怎么搭：1–2 条，允许承担不同角色。 */
  pairing: string[];
  /** 照顾它：2–3 条，切花养护为主，涉及种植时明确区分。 */
  care: string[];
  /** 来源；没有可靠来源时留空并置 unverified。 */
  sources?: KnowledgeSource[];
  /** 没有可核对的来源时显式标 true；界面会显示「尚未核对来源」。 */
  unverified?: boolean;
}

/** 界面文案：花语的定位。 */
export const KNOWLEDGE_MEANING_NOTE = '花语是常见的文化寓意，不是统一标准，同一枝花可以有别的说法。';

/** 界面文案：养护建议的定位（与来源分开，避免让人以为每条都有出处）。 */
export const KNOWLEDGE_CARE_NOTE =
  '养护建议是通用的花艺整理，品种、季节和室内环境都会让实际表现不同；这里说的是切花瓶插，不等于盆栽种植。';

/** 界面文案：模型示意。知识卡的图由游戏内模型渲染，不是实拍。 */
export const KNOWLEDGE_IMAGE_NOTE = '模型示意图：游戏内程序化 / 3D 模型渲染，不是真实品种实拍。';

/** 维基百科来源的统一核对日期（2026-11-10 逐条请求返回 200）。 */
const CHECKED = '2026-11-10';

function wiki(page: string): KnowledgeSource {
  return {
    name: `Wikipedia：${page.replace(/_/g, ' ')}`,
    url: `https://en.wikipedia.org/wiki/${page}`,
    checkedAt: CHECKED,
    note: '仅用于核对学名、别名与基本形态',
  };
}

/** 32 种花型的三节内容。顺序与 data/builtin.ts 的清单保持一致，便于对照。 */
export const FLOWER_KNOWLEDGE: readonly FlowerKnowledge[] = [
  {
    family: 'rose',
    displayName: '玫瑰',
    aka: ['月季（鲜切花商品里常这样叫）'],
    identify: '花瓣一层层从花心向外打开，外瓣边缘常带一点内卷；花枝上通常有刺。',
    meaning: '常见寓意是爱意与欣赏；不同颜色另有约定俗成的差别，但并没有唯一标准。',
    pairing: [
      '单独两三枝就是完整的一束，也能当整束花的视觉中心。',
      '和尤加利、满天星一起用时，给花头留出展开的空间，不要挤在一起。',
    ],
    care: [
      '斜剪茎脚两三厘米，插在浅水里；每天换水时重新剪一次。',
      '尽量不要和水果放在一起，水果释放的乙烯会让花更快开败。',
      '瓶插观赏期通常几天到一周，室温高时更短。',
    ],
    sources: [wiki('Rose')],
  },
  {
    family: 'spray',
    displayName: '多头玫瑰',
    aka: ['小头玫瑰'],
    identify: '一枝上分出好几个小花头，花头比单头玫瑰小一圈，瓶插时显得更密。',
    meaning: '常见寓意和玫瑰相近，也常被用来表达「小小的喜欢」。',
    pairing: [
      '当主花时三四枝就能撑起体量；也可以插在主花之间补层次。',
      '和金鱼草、婆婆纳这类线条花材一起用，能拉出高低。',
    ],
    care: [
      '花头多、吸水快，勤换水；剪掉会泡进水里的叶子。',
      '把开得最早的花头先剪掉，可以延缓整枝的疲态。',
      '瓶插观赏期一般一周上下，比单头玫瑰略短。',
    ],
    sources: [wiki('Rose')],
  },
  {
    family: 'tulip',
    displayName: '郁金香',
    identify: '杯形花头，花瓣厚而光滑，叶子少而宽，整枝线条比较直。',
    meaning: '常见寓意是体贴与爱意，也常被当作春天的花。',
    pairing: [
      '两三枝同色成组最稳；插成不同高度就是阶梯感。',
      '和细叶材搭在一起时不抢画面，适合做轻盈的花束。',
    ],
    care: [
      '剪下后花枝还会继续长高，也会朝光倾斜，摆好当天可能就变形。',
      '水深两三厘米就够，水多容易烂茎。',
      '瓶插观赏期通常五到七天，温度低时能更久。',
    ],
    sources: [wiki('Tulip')],
  },
  {
    family: 'eucalyptus',
    displayName: '尤加利',
    aka: ['桉树叶'],
    identify: '圆或细长的银绿色叶片，叶面有一层粉霜感，枝条柔软。',
    meaning: '常见寓意是回忆与祝福，也常被当作安静的陪伴。',
    pairing: [
      '当叶材托住花头，也能单独插一枝做线条。',
      '和柔和的粉、白、奶油色搭在一起最不抢戏。',
    ],
    care: [
      '剪口木质化，斜剪更利于吸水；水变浑就换。',
      '可以倒挂风干当干花，颜色会慢慢变成灰绿。',
      '瓶插观赏期约一周到十天，干插更久。',
    ],
    sources: [wiki('Eucalyptus')],
  },
  {
    family: 'daisy',
    displayName: '非洲菊',
    aka: ['太阳花（花店口语）'],
    identify: '一圈舌状花瓣围着扁平的花心，颜色明快，花头是平的。',
    meaning: '常见寓意是快乐与元气，也有「藏在心里的喜欢」的说法。',
    pairing: [
      '一枝就能当焦点，适合做明快的小花束。',
      '和满天星、小碎花一起用，花心不会被淹没。',
    ],
    care: [
      '花茎容易软，插浅水；水一多容易烂茎、花头下垂。',
      '可以用细铁丝从茎中穿过，帮花头立住。',
      '瓶插观赏期通常五到七天。',
    ],
    sources: [wiki('Gerbera')],
  },
  {
    family: 'peony',
    displayName: '牡丹',
    identify: '层层大瓣团成球，外瓣半张、内瓣收拢，花头很重。',
    meaning: '常见寓意是富贵与圆满。',
    pairing: [
      '一两枝就能当整束主角，其余花材少一点反而更显层次。',
      '和细叶材、素色包装一起用，避免和它抢戏。',
    ],
    care: [
      '花头重，瓶口要稳；水浅一点、勤换水。',
      '开放后遇热会很快散瓣，想慢点开就放在凉一点的地方。',
      '瓶插观赏期一般几天，不是耐久型的花。',
    ],
    sources: [wiki('Peony')],
  },
  {
    family: 'herbaceous-peony',
    displayName: '芍药',
    identify: '半开的杯形，花瓣薄而略带褶皱，中央常露出一圈花蕊。',
    meaning: '常见寓意是惜别与温柔，也常被当作「将开未开」的美。',
    pairing: [
      '做主花时配一两种细碎配花就够，不必堆满。',
      '紧花苞可以放进温水里慢慢催开，适合要等客人的场合。',
    ],
    care: [
      '买回来若是紧花苞，温水加上轻轻揉开花苞外瓣，可以催开。',
      '剪茎后先充分吸水，之后每天换水。',
      '开放后的观赏期通常三到五天。',
    ],
    sources: [wiki('Paeonia_lactiflora')],
  },
  {
    family: 'carnation',
    displayName: '康乃馨',
    identify: '花瓣边缘细碎带齿，花头是紧实的圆顶，茎上的节很明显。',
    meaning: '常见寓意是感谢与牵挂，常用来表达对长辈的心意。',
    pairing: [
      '做主花时成团插更有分量，也可以当填缝的圆点。',
      '和玫瑰、洋桔梗一起用，圆顶能柔化整束。',
    ],
    care: [
      '节处容易折断，斜剪时尽量剪在节间；水位不要太高。',
      '对乙烯敏感，远离水果与香烟。',
      '瓶插观赏期通常一到两周，是较耐久的一类。',
    ],
    sources: [wiki('Dianthus_caryophyllus')],
  },
  {
    family: 'lily',
    displayName: '百合',
    identify: '六片花瓣向外翻卷，中央有突出的花蕊，花头较大。',
    meaning: '常见寓意是纯洁与祝福，也有「百年好合」的说法。',
    pairing: [
      '一枝就能当焦点，其他花材宜少、宜矮。',
      '和绿叶、白色系花材一起时最显干净。',
    ],
    care: [
      '花粉会染色，开花前把花药摘掉，也避免沾到衣物。',
      '花头重，选高一点的瓶子；每天换水。',
      '瓶插观赏期通常一周左右；对猫有毒，家里有猫时不要摆。',
    ],
    sources: [wiki('Lilium')],
  },
  {
    family: 'sunflower',
    displayName: '向日葵',
    identify: '深色花盘外周一圈黄色舌状瓣，花头大、茎粗。',
    meaning: '常见寓意是阳光与希望。',
    pairing: [
      '一两枝就是主角，适合明亮、松弛的风格。',
      '和绿叶、牛皮纸包装最搭，不建议再叠太多颜色。',
    ],
    care: [
      '吸水快、花头重，需要高瓶和充足的水。',
      '茎粗，斜剪后可以在切口往上纵剪一小口帮助吸水。',
      '瓶插观赏期通常五到七天。',
    ],
    sources: [wiki('Common_sunflower')],
  },
  {
    family: 'dahlia',
    displayName: '大丽花',
    identify: '多层尖瓣排出规整的莲座状，花头圆而饱满。',
    meaning: '常见寓意是华丽与变化，也常被当作「独特的偏爱」。',
    pairing: [
      '单枝插在小瓶里就成立；做主角时其他花材宜轻。',
      '和细穗状配花一起用，能保持轮廓清楚。',
    ],
    care: [
      '茎是中空的，插浅水，避免水进到茎里。',
      '不要往花瓣上喷水，容易留斑。',
      '瓶插观赏期通常三到五天，属于偏短的一类。',
    ],
    sources: [wiki('Dahlia')],
  },
  {
    family: 'calla',
    displayName: '马蹄莲',
    identify: '单片花瓣卷成漏斗，中间立着一根肉穗，茎和花都很简洁。',
    meaning: '常见寓意是优雅与纯粹。',
    pairing: [
      '两三枝成组最有线条感，适合极简风格的花束。',
      '和尤加利、熊草这类细叶材一起用很利落。',
    ],
    care: [
      '茎软，瓶口要能扶住；浅水养护。',
      '汁液有刺激性，处理时避免沾到眼睛和皮肤。',
      '瓶插观赏期通常五到七天。',
    ],
    sources: [wiki('Zantedeschia')],
  },
  {
    family: 'lisianthus',
    displayName: '洋桔梗',
    aka: ['草原龙胆（植物学上的名字）'],
    identify: '花瓣薄而叠成杯状，边缘略有波浪，一朵上有好几层。',
    meaning: '常见寓意是真诚与不变的爱。',
    pairing: [
      '可以当主花，也能填在主花之间柔化边缘。',
      '和玫瑰、满天星一起用几乎不挑颜色。',
    ],
    care: [
      '茎节较软，剪后容易弯，插的时候给一点支撑。',
      '勤换水、勤剪茎，能明显延长状态。',
      '瓶插观赏期通常一到两周，属于耐久的花。',
    ],
    sources: [wiki('Eustoma')],
  },
  {
    family: 'alstroemeria',
    displayName: '六出花',
    identify: '漏斗形小花成簇开放，内瓣常带斑点或条纹。',
    meaning: '常见寓意是相伴与关怀。',
    pairing: [
      '当配花很好用，也可以成簇做主花的一部分。',
      '和玫瑰、洋桔梗同色系一起用，层次会显得更多。',
    ],
    care: [
      '摘掉下部叶片，避免泡在水里腐烂。',
      '花茎自下而上开，先开的花可以摘掉。',
      '瓶插观赏期通常一到两周，较耐久。',
    ],
    sources: [wiki('Alstroemeria')],
  },
  {
    family: 'spray-chrysanthemum',
    displayName: '多头小菊',
    identify: '一枝分出几个小圆花头，花瓣短而密，颜色干净。',
    meaning: '常见寓意是淡泊与长久。',
    pairing: [
      '填补花与花之间的空隙，也能成把插出蓬松感。',
      '和玫瑰、尤加利一起用时不会抢主花。',
    ],
    care: [
      '剪掉多余的小花头与下部叶，水才不容易浑。',
      '对乙烯敏感，远离水果。',
      '瓶插观赏期通常一到两周。',
    ],
    sources: [wiki('Chrysanthemum')],
  },
  {
    family: 'babys-breath',
    displayName: '满天星',
    identify: '细枝上密密的小白点，枝条很轻，几乎没有重量。',
    meaning: '常见寓意是守望与纯粹的心意。',
    pairing: [
      '少量点缀就能让整束透气；用得太多会显乱。',
      '和玫瑰、康乃馨同色系搭配最稳。',
    ],
    care: [
      '茎细，剪后容易干，浅水快插。',
      '可以倒挂做成干花，颜色会变成更柔和的米白。',
      '瓶插观赏期约一周，干后能放很久。',
    ],
    sources: [wiki('Gypsophila_paniculata')],
  },
  {
    family: 'statice',
    displayName: '补血草',
    aka: ['勿忘我（花市叫法；与真正的勿忘我 Myosotis 不是同一种植物）'],
    identify: '纸质小花摊成平顶，茎偏硬，摸起来是干爽的。',
    meaning: '常见寓意是永恒的记忆。',
    pairing: [
      '当配花撑住轮廓，也可以单独插一小瓶。',
      '和尤加利、满天星一起做干花风格最合适。',
    ],
    care: [
      '可以做干花：直接倒挂阴干，几乎不会变形。',
      '切花状态也比较耐久，不需要频繁换水。',
      '瓶插观赏期常常超过一周。',
    ],
    sources: [wiki('Limonium')],
  },
  {
    family: 'waxflower',
    displayName: '澳洲蜡花',
    identify: '星形小蜡花夹着圆润的花苞，枝叶细，带一点蜡质光泽。',
    meaning: '常见寓意是甜蜜的回忆。',
    pairing: [
      '填缝和加香味层次都合适，用量少一点更好。',
      '和玫瑰、小菊一起用能带出庭园感。',
    ],
    care: [
      '叶枝容易掉，插好后尽量少搬动。',
      '浅水养护、勤换水，可以延长状态。',
      '瓶插观赏期约一到两周。',
    ],
    sources: [wiki('Chamelaucium')],
  },
  {
    family: 'rice-flower',
    displayName: '小米花',
    identify: '米粒大小的圆苞串在细枝上，颜色偏奶油白或浅绿。',
    meaning: '常见寓意是细小的幸福。',
    pairing: [
      '当配花填空隙，或成小把插在边缘。',
      '和尤加利、洋桔梗一起做低饱和花束很合适。',
    ],
    care: [
      '细枝容易干，插前重剪并保持浅水。',
      '可以倒挂做干花，颜色会保留较久。',
      '瓶插观赏期常常超过一周。',
    ],
    sources: [wiki('Ozothamnus_diosmifolius')],
  },
  {
    family: 'veronica',
    displayName: '婆婆纳',
    identify: '细长的花穗，小花自下而上开，像一条竖直的线。',
    meaning: '常见寓意是忠诚与信任。',
    pairing: [
      '当线条花材，能拉高整束的比例。',
      '和圆形主花形成对比，画面会更有节奏。',
    ],
    care: [
      '剪掉会泡进水里的下段叶，防止烂水。',
      '花穗会继续往上开，谢掉的下段可以剪掉。',
      '瓶插观赏期通常一周左右。',
    ],
    sources: [wiki('Veronica_(plant)')],
  },
  {
    family: 'snapdragon',
    displayName: '金鱼草',
    identify: '总状花序，唇形小花从下往上开，捏花冠会开合。',
    meaning: '常见寓意是活力与勇气。',
    pairing: [
      '做线条与高度，适合放在整束的上部。',
      '和玫瑰、小菊一起用能带出向上生长的感觉。',
    ],
    care: [
      '花穗自下而上开，先谢的可以摘掉。',
      '对乙烯敏感，远离水果。',
      '瓶插观赏期通常一到两周。',
    ],
    sources: [wiki('Antirrhinum')],
  },
  {
    family: 'ruscus',
    displayName: '鲁斯卡斯',
    aka: ['意大利鲁斯卡斯（花市商品名）'],
    identify: '茎上互生卵形「假叶」，叶尖微尖，质地偏硬有光泽。',
    meaning: '叶材没有统一的花语，常见说法是清爽与守护。',
    pairing: [
      '托在花束底层或向外探出，撑住轮廓。',
      '和浅色花一起时，深绿能压住整束的重心。',
    ],
    care: [
      '叶面容易积灰，可以用湿布轻擦。',
      '剪茎时斜剪，浅水养护。',
      '瓶插观赏期通常一到两周；也能干插。',
    ],
    sources: [wiki('Ruscus')],
  },
  {
    family: 'salal',
    displayName: '沙柳叶',
    aka: ['沙龙叶'],
    identify: '大而厚的革质叶，叶缘略有锯齿，叶面暗绿。',
    meaning: '叶材没有统一的花语，常见说法是稳重与包容。',
    pairing: [
      '做大叶托底，适合需要体量的花束。',
      '和玫瑰、绣球这类大花头一起用，比例更稳。',
    ],
    care: [
      '叶片大、蒸发快，勤换水。',
      '可以擦掉叶面水渍，保持质感。',
      '瓶插观赏期通常一到两周。',
    ],
    sources: [wiki('Gaultheria_shallon')],
  },
  {
    family: 'asparagus-fern',
    displayName: '文竹',
    aka: ['芦笋蕨（花市俗称）'],
    identify: '细羽状的分枝，看起来像蕨类，其实是天门冬属植物，并不是蕨。',
    meaning: '常见寓意是文雅与长久。',
    pairing: [
      '做轻盈的填充，适合松散的花束。',
      '和玫瑰、满天星一起用会显得很透气。',
    ],
    care: [
      '分枝细，剪后容易干；插前重剪。',
      '浅水养护，避免叶片泡水。',
      '瓶插观赏期通常一周左右。',
    ],
    sources: [wiki('Asparagus_setaceus')],
  },
  {
    family: 'leatherleaf',
    displayName: '皮革蕨',
    aka: ['革叶蕨'],
    identify: '长椭圆革质叶，边缘有细锯齿，叶柄硬挺。',
    meaning: '叶材没有统一的花语，常见说法是坚韧与陪伴。',
    pairing: [
      '给花束做底与边缘，能把花头托起来。',
      '大叶容易抢戏，用量少一点更耐看。',
    ],
    care: [
      '叶柄坚硬，斜剪或轻拍切口更利于吸水。',
      '勤换水，避免叶片泡水。',
      '瓶插观赏期通常一到两周。',
    ],
    sources: [wiki('Rumohra_adiantiformis')],
  },
  {
    family: 'boston-fern',
    displayName: '肾蕨',
    identify: '羽状复叶，小叶密集排列，整枝像一条绿色羽毛。',
    meaning: '常见寓意是热情与自在。',
    pairing: [
      '往外侧铺开，做花束的轮廓与体量。',
      '和郁金香、洋桔梗一起用能显得柔和。',
    ],
    care: [
      '叶片薄、蒸发快，勤换水。',
      '剪掉下部小叶，避免泡水发腐。',
      '瓶插观赏期通常一周左右。',
    ],
    sources: [wiki('Nephrolepis_exaltata')],
  },
  {
    family: 'ivy',
    displayName: '常春藤',
    identify: '三裂心形叶，枝条柔软，会自然垂下来。',
    meaning: '常见寓意是长久的陪伴与忠诚。',
    pairing: [
      '让枝条垂出瓶口，做流动感与线条。',
      '和圆形花束搭配时能加一点自然野趣。',
    ],
    care: [
      '枝条容易缠在一起，插前先理顺。',
      '可以喷少量水在叶面保持新鲜。',
      '瓶插观赏期通常约一周。',
    ],
    sources: [wiki('Hedera')],
  },
  {
    family: 'fatsia',
    displayName: '八角金盘',
    identify: '掌状深裂的大叶，叶面有光泽，存在感很强。',
    meaning: '叶材没有统一的花语，常见说法是聚拢与丰盛。',
    pairing: [
      '做背景叶，给花束一个暗色的衬底。',
      '一两片就够，太多会压住花头。',
    ],
    care: [
      '大叶蒸发快，浅水勤换。',
      '叶面擦干净，观感差别很大。',
      '瓶插观赏期通常一到两周。',
    ],
    sources: [wiki('Fatsia_japonica')],
  },
  {
    family: 'aspidistra',
    displayName: '蜘蛛抱蛋叶',
    aka: ['一叶兰'],
    identify: '长带状的深绿单叶，叶脉平行，立得住。',
    meaning: '叶材没有统一的花语，常见说法是坚韧与安静。',
    pairing: [
      '卷曲或折叠后可以做造型线条。',
      '和体量大的主花一起用能拉出纵向比例。',
    ],
    care: [
      '单叶没有长茎，插前留一小段叶柄。',
      '浅水养护，避免叶面长期沾水。',
      '瓶插观赏期通常一到两周。',
    ],
    sources: [wiki('Aspidistra_elatior')],
  },
  {
    family: 'bear-grass',
    displayName: '熊草',
    identify: '细长草叶从基部散开，叶尖轻，整把像一束光。',
    meaning: '常见寓意是自由与轻盈。',
    pairing: [
      '做外圈的放射线条，让花束显得更松。',
      '和松散自然的风格一起用最合适。',
    ],
    care: [
      '草叶易折，插的时候避免反复弯折。',
      '浅水养护，剪掉会泡水的下段。',
      '瓶插观赏期通常约一周。',
    ],
    sources: [wiki('Xerophyllum_tenax')],
  },
  {
    family: 'hydrangea',
    displayName: '绣球',
    aka: ['八仙花'],
    identify: '一整个花球由许多四瓣小花组成，花球圆而饱满，叶片大而阔。',
    meaning: '常见寓意是圆满与希望。',
    pairing: [
      '一团就能占住画面，适合当大块面主花。',
      '和线条花材、细叶材搭在一起才不会显得闷。',
    ],
    care: [
      '切花很怕缺水：水要深、茎要斜剪；整枝有点蔫时可以整枝浸入清水帮助恢复。',
      '不要放在风口与直射光下，每天换水重剪。',
      '瓶插观赏期因品种与室温差异很大，通常几天到一周。',
    ],
    sources: [wiki('Hydrangea_macrophylla')],
  },
  {
    family: 'orchid',
    displayName: '蝴蝶兰',
    identify: '花被片平展开来，中央有唇瓣，整朵像一只停着的蝴蝶；叶子宽厚贴在基部。',
    meaning: '常见寓意是优雅与幸福向你飞来。',
    pairing: [
      '一两枝就有造型感，适合当整束的焦点或线条。',
      '和大量绿叶、素色包装一起用时最耐看。',
    ],
    care: [
      '切花怕闷热，放在阴凉处；水里不要留叶子。',
      '单朵花能开较久，整枝瓶插观感通常按周计，但剪下后不会像盆栽那样继续生长。',
      '注意：这是切花养护，不等于盆栽蝴蝶兰的种植方法。',
    ],
    sources: [wiki('Phalaenopsis')],
  },
];

const KNOWLEDGE_BY_FAMILY: Record<string, FlowerKnowledge> = Object.fromEntries(
  FLOWER_KNOWLEDGE.map((item) => [item.family, item]),
);

/** 查一种花的知识；目录里没有对应内容时返回 undefined（界面显示占位说明）。 */
export function knowledgeFor(family: string): FlowerKnowledge | undefined {
  return KNOWLEDGE_BY_FAMILY[family];
}

/** 有知识内容的花科数量（验收脚本会断言 = 目录花型数）。 */
export const KNOWLEDGE_FAMILY_COUNT = FLOWER_KNOWLEDGE.length;

/** 有知识内容的花科清单。 */
export function knowledgeFamilies(): string[] {
  return FLOWER_KNOWLEDGE.map((item) => item.family);
}

/** 来源展示用的简短文案。 */
export function sourceLabel(source: KnowledgeSource): string {
  return `${source.name}（核对 ${source.checkedAt}${source.note ? `，${source.note}` : ''}）`;
}
