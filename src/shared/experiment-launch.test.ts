import { describe, expect, it } from 'vitest'
import { deviceLaunchCommand, resolveExperimentLaunch } from './experiment-launch'

describe('compute device and command synchronization',()=>{
  it.each(['--device=cuda','--device cuda:2','--device="cuda:0"',"--device 'gpu'"] )('switches existing device values in both directions: %s', argument=>{
    const original=`python main.py ${argument} --epochs=1`
    const cpu=deviceLaunchCommand(original,'cpu')
    expect(cpu).toContain('cpu')
    expect(cpu).not.toMatch(/cuda|gpu/)
    const gpu=deviceLaunchCommand(cpu,'gpu')
    expect(gpu).toContain('cuda')
    expect(gpu).not.toContain('cpu')
    expect(gpu).toContain('--epochs=1')
  })
  it('preserves whitespace, quotes and an already valid GPU device',()=>{
    expect(deviceLaunchCommand('python  main.py --device="cpu"  --name "a b"','gpu')).toBe('python  main.py --device="cuda"  --name "a b"')
    expect(deviceLaunchCommand('python main.py --device=cuda:3','gpu')).toBe('python main.py --device=cuda:3')
  })
  it.each(['python main.py','python main.py --device=mps','python main.py --note "--device=cpu"',"bash -c 'python main.py --device=cpu'",'python main.py -- --device=cpu','python first.py --device=cpu && python second.py','python main.py --device=$DEVICE'])('leaves absent, dynamic and unrelated device text unchanged: %s', command=>{
    expect(deviceLaunchCommand(command,'gpu')).toBe(command)
  })
  it('synchronizes the launch snapshot but does not add arguments to shell scripts',()=>{
    expect(resolveExperimentLaunch({codePath:'/project',launchCommand:'python main.py --device cpu',computeDevice:'gpu'}).launchCommand).toBe('python main.py --device cuda')
    expect(resolveExperimentLaunch({codePath:'/project',launchMode:'script',scriptPath:'/project/train.sh',computeDevice:'gpu'}).launchCommand).toBe("bash -- '/project/train.sh'")
  })
})
