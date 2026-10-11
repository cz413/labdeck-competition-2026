export function nvidiaXml(used = 27034, processUsed = ['1365', '25000'], uuid = 'GPU-one'): string {
  return `<?xml version="1.0"?>
<!DOCTYPE nvidia_smi_log SYSTEM "nvsmi_device_v12.dtd">
<nvidia_smi_log><attached_gpus>1</attached_gpus><gpu id="00000000:01:00.0">
<product_name>NVIDIA CMP 170HX</product_name><uuid>${uuid}</uuid><minor_number>4</minor_number>
<fb_memory_usage><total>65536 MiB</total><reserved>64 MiB</reserved><used>${used} MiB</used><free>${65536 - used} MiB</free></fb_memory_usage>
<utilization><gpu_util>97 %</gpu_util><memory_util>48 %</memory_util></utilization>
<temperature><gpu_temp>73 C</gpu_temp></temperature><fan_speed>N/A</fan_speed><performance_state>P0</performance_state>
<power_readings><power_draw>94.25 W</power_draw><power_limit>250.00 W</power_limit></power_readings>
<processes>${processUsed.map((memory, index) => `<process_info><pid>${42 + index}</pid><type>${index ? 'G' : 'C'}</type><process_name>/home/user/a&amp;b/python</process_name><used_memory>${memory === 'N/A' ? memory : `${memory} MiB`}</used_memory></process_info>`).join('')}</processes>
</gpu></nvidia_smi_log>`
}
