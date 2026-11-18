"""A tiny stand-in for MediaPipe Selfie Segmentation in the Style Konsep end-to-end test (test/e2e/stylefx.mjs).

Same input and output as onnx-community/mediapipe_selfie_segmentation (input pixel_values [1,3,256,256], RGB 0-1;
output alphas [1,1,256,256], 0-1), but a "person" is simply where the picture is red: alpha = sigmoid(30 * (R - G - 0.25)).
The test video draws its person in red on a grey wall. It lets the test run the whole path (onnxruntime-web on
WebAssembly, frames, the project's person masks, the style placing its texts) in seconds; the real model is checked on
real footage separately (NAJJA_TEST_FACE_VIDEO).
Run: python3 test/fixtures/make-person-test-model.py  (needs: pip install onnx) → test/fixtures/person-test-model.onnx
"""
import os
import onnx
from onnx import helper, TensorProto

x = helper.make_tensor_value_info('pixel_values', TensorProto.FLOAT, [1, 3, 256, 256])
y = helper.make_tensor_value_info('alphas', TensorProto.FLOAT, [1, 1, 256, 256])
nodes = [
    helper.make_node('Slice', ['pixel_values', 'r0', 'r1', 'ax'], ['red']),
    helper.make_node('Slice', ['pixel_values', 'g0', 'g1', 'ax'], ['green']),
    helper.make_node('Sub', ['red', 'green'], ['d']),
    helper.make_node('Sub', ['d', 'bias'], ['e']),
    helper.make_node('Mul', ['e', 'gain'], ['z']),
    helper.make_node('Sigmoid', ['z'], ['alphas']),
]
inits = [
    helper.make_tensor('r0', TensorProto.INT64, [1], [0]),
    helper.make_tensor('r1', TensorProto.INT64, [1], [1]),
    helper.make_tensor('g0', TensorProto.INT64, [1], [1]),
    helper.make_tensor('g1', TensorProto.INT64, [1], [2]),
    helper.make_tensor('ax', TensorProto.INT64, [1], [1]),
    helper.make_tensor('bias', TensorProto.FLOAT, [], [0.25]),
    helper.make_tensor('gain', TensorProto.FLOAT, [], [30.0]),
]
g = helper.make_graph(nodes, 'person-test', [x], [y], inits)
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 13)], producer_name='najja-test')
m.ir_version = 8
onnx.checker.check_model(m)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'person-test-model.onnx')
onnx.save(m, out)
print(out, os.path.getsize(out), 'bytes')
