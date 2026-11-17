"""A tiny stand-in for BiRefNet in the background-removal end-to-end test (test/e2e/cutout.mjs).

Same input and output as birefnet-lite-512 (input [1,3,512,512] normalised with the ImageNet mean/std, output [1,1,512,512]
logits), but the "subject" is simply where the picture is colourful: logits = 40 * (max(RGB) - min(RGB)) - 4. On a grey
wall that is the background, on a colourful object the subject. It lets the test run the whole pipeline (onnxruntime-web,
WebGPU, frames, masks, upload, preview, export) in seconds; BiRefNet itself is checked on real pictures separately.
Run: python3 test/fixtures/make-bg-test-model.py  (needs: pip install onnx) → test/fixtures/bg-test-model.onnx
"""
import os
import onnx
from onnx import helper, TensorProto

x = helper.make_tensor_value_info('input_image', TensorProto.FLOAT, [1, 3, 512, 512])
y = helper.make_tensor_value_info('output_image', TensorProto.FLOAT, [1, 1, 512, 512])
nodes = [
    helper.make_node('ReduceMax', ['input_image', 'axes'], ['mx'], keepdims=1),
    helper.make_node('ReduceMin', ['input_image', 'axes'], ['mn'], keepdims=1),
    helper.make_node('Sub', ['mx', 'mn'], ['spread']),
    helper.make_node('Mul', ['spread', 'k'], ['scaled']),
    helper.make_node('Sub', ['scaled', 'b'], ['output_image']),
]
inits = [
    helper.make_tensor('axes', TensorProto.INT64, [1], [1]),
    helper.make_tensor('k', TensorProto.FLOAT, [], [9.0]),  # (normalised values: a spread of ~1.0 for colour, ~0.1 for grey)
    helper.make_tensor('b', TensorProto.FLOAT, [], [4.0]),
]
g = helper.make_graph(nodes, 'bg-test', [x], [y], inits)
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 18)], producer_name='najja-test')
m.ir_version = 9
onnx.checker.check_model(m)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bg-test-model.onnx')
onnx.save(m, out)
print(out, os.path.getsize(out), 'bytes')
