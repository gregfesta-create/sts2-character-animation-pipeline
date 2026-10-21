"""Development-only coverage gate using pinned coverage.py and CPython call events."""
import cProfile
import json
from pathlib import Path
import sys
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.devtools/python'))
import coverage

WORKERS = sorted((ROOT / 'workers').rglob('*.py'))
EVIDENCE = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'evidence/python-validation'


def definitions(code):
    result = []
    for child in code.co_consts:
        if isinstance(child, types.CodeType):
            # Comprehensions are execution expressions, not declared functions.
            if not child.co_name.startswith('<'):
                result.append(child)
            result.extend(definitions(child))
    return result


def main():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    cov = coverage.Coverage(branch=True, source=[str(ROOT / 'workers')], data_file=str(EVIDENCE / '.coverage'))
    profiler = cProfile.Profile()
    cov.start()
    profiler.enable()
    suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern='test_*.py')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    profiler.disable()
    cov.stop()
    cov.save()
    cov.json_report(outfile=str(EVIDENCE / 'coverage.json'), include=[str(worker) for worker in WORKERS])
    raw = json.loads((EVIDENCE / 'coverage.json').read_text())
    report = raw['totals']
    measured = {Path(filename).resolve() for filename in raw['files']}
    missing_workers = [str(worker) for worker in WORKERS if worker.resolve() not in measured]
    calls = {(Path(entry.code.co_filename).resolve(), entry.code.co_firstlineno, entry.code.co_name) for entry in profiler.getstats() if isinstance(entry.code, types.CodeType) and entry.callcount > 0}
    functions = [dict(file=str(worker), name=code.co_name, line=code.co_firstlineno, covered=(worker.resolve(), code.co_firstlineno, code.co_name) in calls) for worker in WORKERS for code in definitions(compile(worker.read_text(), str(worker), 'exec'))]
    metrics = dict(lines=100 * report['covered_lines'] / report['num_statements'], statements=100 * report['covered_lines'] / report['num_statements'], branches=100 * report['covered_branches'] / report['num_branches'], functions=100 * sum(f['covered'] for f in functions) / len(functions))
    thresholds = json.loads((ROOT.parent / '.coverage-thresholds.json').read_text())['thresholds']
    passed = result.wasSuccessful() and not missing_workers and all(metrics[key] >= thresholds[key] for key in metrics)
    output = dict(passed=passed, metrics=metrics, thresholds=thresholds, functions=functions, missingWorkers=missing_workers, workers=[str(worker) for worker in WORKERS], statementDefinition='coverage.py executable statement lines (num_statements), not Istanbul JavaScript expression statements', functionDefinition='Declared function code objects recursively compiled from every worker source; covered only by matching CPython cProfile call events; comprehensions excluded', testsRun=result.testsRun, skipped=len(result.skipped), coverageVersion=coverage.__version__)
    (EVIDENCE / 'gate.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps(output, indent=2))
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
