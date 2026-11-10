import './customer-portrait.css';

const PEOPLE: Record<string, { file: string; name: string }> = {
  'c1-birthday': { file: 'lin', name: '林女士' },
  'c2-new-home': { file: 'ache', name: '阿澈' },
  'c3-anniversary': { file: 'xiaoman', name: '小满' },
  // V13 新增的三封来信还没有立绘：用一封素色信笺上的姓氏字代替，
  // 不借用别人的照片，也不假装有了新人物图。
  'c4-sunflower-basket': { file: '', name: '老潘' },
  'c5-new-home-pot': { file: '', name: '沈岚' },
  'c6-anniversary-box': { file: '', name: '顾先生' },
};

export function CustomerPortrait({ id, small = false }: { id: string; small?: boolean }): React.JSX.Element | null {
  const person = PEOPLE[id];
  if (!person) return null;
  if (!person.file) {
    return (
      <div
        className={`customer-portrait is-initial ${small ? 'is-small' : ''}`}
        role="img"
        aria-label={`${person.name}（还没有立绘，用姓氏字代替）`}
        data-testid={`portrait-initial-${id}`}
      >
        <span aria-hidden="true">{Array.from(person.name)[0]}</span>
      </div>
    );
  }
  return <img className={`customer-portrait ${small ? 'is-small' : ''}`} src={`${import.meta.env.BASE_URL}assets/characters/${person.file}.webp`} alt={person.name} />;
}
