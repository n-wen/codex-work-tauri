import { useMemo, useState } from 'react';
import type { ToolUserInputQuestion, ToolUserInputRequest } from '../types';

interface Props {
  request: ToolUserInputRequest;
  onRespond: (answers: Record<string, { answers: string[] }>) => void;
  onCancel: () => void;
}

function QuestionBlock({
  q,
  value,
  other,
  onChange,
  onOtherChange,
}: {
  q: ToolUserInputQuestion;
  value: string[];
  other: string;
  onChange: (next: string[]) => void;
  onOtherChange: (next: string) => void;
}) {
  const options = q.options ?? [];
  const multi = options.length > 1 && !q.isSecret;

  return (
    <div className="form-field" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 600 }}>{q.header || q.question}</div>
      {q.header && q.question && q.header !== q.question && (
        <div className="form-hint">{q.question}</div>
      )}
      {options.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {options.map((opt) => {
            const checked = value.includes(opt.label);
            return (
              <label key={opt.label} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={`q-${q.id}`}
                  checked={checked}
                  onChange={() => {
                    if (multi) {
                      onChange(
                        checked ? value.filter((v) => v !== opt.label) : [...value, opt.label],
                      );
                    } else {
                      onChange([opt.label]);
                    }
                  }}
                />
                <span>
                  <strong>{opt.label}</strong>
                  {opt.description ? (
                    <span className="form-hint" style={{ display: 'block' }}>
                      {opt.description}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {(q.isOther || options.length === 0 || q.isSecret) && (
        <input
          type={q.isSecret ? 'password' : 'text'}
          value={other}
          onChange={(e) => onOtherChange(e.target.value)}
          placeholder={q.isSecret ? '密钥 / 私密输入' : '其他…'}
          style={{ marginTop: 8, width: '100%' }}
        />
      )}
    </div>
  );
}

export function ToolUserInputDialog({ request, onRespond, onCancel }: Props) {
  const questions = request.questions ?? [];
  const [selected, setSelected] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const q of questions) init[q.id] = [];
    return init;
  });
  const [otherText, setOtherText] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of questions) init[q.id] = '';
    return init;
  });

  const canSubmit = useMemo(() => {
    return questions.every((q) => {
      const picks = selected[q.id] ?? [];
      const other = (otherText[q.id] ?? '').trim();
      return picks.length > 0 || other.length > 0;
    });
  }, [questions, selected, otherText]);

  const submit = () => {
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of questions) {
      const picks = [...(selected[q.id] ?? [])];
      const other = (otherText[q.id] ?? '').trim();
      if (other) picks.push(other);
      answers[q.id] = { answers: picks };
    }
    onRespond(answers);
  };

  return (
    <div className="modal-backdrop">
      <div className="approval-box" style={{ maxWidth: 480 }}>
        <h3>工具需要输入</h3>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          Agent 工具向你提问，请完成后再继续。
        </p>
        {questions.map((q) => (
          <QuestionBlock
            key={q.id}
            q={q}
            value={selected[q.id] ?? []}
            other={otherText[q.id] ?? ''}
            onChange={(next) => setSelected((s) => ({ ...s, [q.id]: next }))}
            onOtherChange={(next) => setOtherText((s) => ({ ...s, [q.id]: next }))}
          />
        ))}
        <div className="panel-actions approval-actions-row">
          <button type="button" className="btn btn-danger" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={submit}
          >
            提交
          </button>
        </div>
      </div>
    </div>
  );
}
