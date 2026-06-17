interface Step {
  step: string;
  stepNumber: number;
  totalSteps: number;
}

interface Props {
  currentStep: Step | null;
  error: string | null;
}

const STEPS_4 = [
  'Checking our database...',
  'Fetching the restaurant page...',
  'Analysing dishes with AI...',
  'Saving your results...',
];

const STEPS_5 = [
  'Finding restaurant website...',
  'Checking our database...',
  'Fetching the restaurant page...',
  'Analysing dishes with AI...',
  'Saving your results...',
];

export default function ParseProgress({ currentStep, error }: Props) {
  const totalSteps = currentStep?.totalSteps ?? 4;
  const steps = totalSteps >= 5 ? STEPS_5 : STEPS_4;
  const currentStepNumber = currentStep?.stepNumber ?? 0;

  return (
    <div className="card p-6 max-w-md w-full">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-8 h-8 rounded-full bg-picky-100 flex items-center justify-center">
          <span className="text-lg">🥦</span>
        </div>
        <div>
          <p className="font-semibold text-gray-900">Analysing menu</p>
          <p className="text-sm text-gray-500">This usually takes 10–15 seconds</p>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
          <p className="text-sm font-semibold text-amber-800 mb-1">Oops, we hit a snag</p>
          <p className="text-sm text-amber-700">{error}</p>
        </div>
      ) : (
        <ol className="space-y-3">
          {steps.map((step, i) => {
            const stepNum = i + 1;
            const isDone = stepNum < currentStepNumber;
            const isActive = stepNum === currentStepNumber;

            return (
              <li key={step} className="flex items-center gap-3">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold transition-all duration-300 ${
                    isDone
                      ? 'bg-picky-600 text-white'
                      : isActive
                      ? 'bg-picky-100 border-2 border-picky-600 progress-active'
                      : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {isDone ? '✓' : stepNum}
                </div>
                <span
                  className={`text-sm transition-colors duration-300 ${
                    isDone
                      ? 'text-gray-500 line-through'
                      : isActive
                      ? 'text-gray-900 font-medium'
                      : 'text-gray-400'
                  }`}
                >
                  {step}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
