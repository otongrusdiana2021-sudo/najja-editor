"""A tiny stand-in for the UltraFace RFB-320 face detector in the Style Konsep end-to-end test (test/e2e/stylefx.mjs).

Same input and outputs as version-RFB-320 (input [1,3,240,320], (RGB-127)/128; outputs scores [1,N,2] and boxes [1,N,4]
as 0-1 of the input), with one anchor: a "face" is a red patch in the upper middle of a 9:16 picture letterboxed into
the input (the test video draws one there while the person "talks"). score = sigmoid(20 * (mean red there - 0.4)); the
box is fixed: x 0.3-0.7, y 0.15-0.4 of the 9:16 picture. It lets the test run the whole path (onnxruntime-web on
WebAssembly, frames, letterbox, decoding, the project's face data, the style placing its texts) in seconds; the real
model is checked on real footage separately (NAJJA_TEST_FACE_VIDEO).
Run: python3 test/fixtures/make-face-test-model.py  (needs: pip install onnx) → test/fixtures/face-test-model.onnx
"""
import os
import onnx
from onnx import helper, TensorProto

x = helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 240, 320])
scores = helper.make_tensor_value_info('scores', TensorProto.FLOAT, [1, 1, 2])
boxes = helper.make_tensor_value_info('boxes', TensorProto.FLOAT, [1, 1, 4])
# a 360x640 picture in 320x240: 135 px wide from x 92.5; the face x 108-252, y 96-256 of the picture → x 133-187, y 36-96
nodes = [
    helper.make_node('Slice', ['input', 'starts', 'ends', 'axes'], ['patch']),
    helper.make_node('ReduceMean', ['patch'], ['red'], axes=[0, 1, 2, 3], keepdims=0),
    helper.make_node('Sub', ['red', 'half'], ['d']),
    helper.make_node('Mul', ['d', 'gain'], ['z']),
    helper.make_node('Sigmoid', ['z'], ['s1']),
    helper.make_node('Sub', ['one', 's1'], ['s0']),
    helper.make_node('Reshape', ['s0', 'shape'], ['s0r']),
    helper.make_node('Reshape', ['s1', 'shape'], ['s1r']),
    helper.make_node('Concat', ['s0r', 's1r'], ['scores'], axis=2),
    helper.make_node('Identity', ['box'], ['boxes']),
]
inits = [
    helper.make_tensor('starts', TensorProto.INT64, [4], [0, 0, 45, 140]),
    helper.make_tensor('ends', TensorProto.INT64, [4], [1, 1, 90, 180]),
    helper.make_tensor('axes', TensorProto.INT64, [4], [0, 1, 2, 3]),
    helper.make_tensor('half', TensorProto.FLOAT, [], [0.4]),
    helper.make_tensor('gain', TensorProto.FLOAT, [], [20.0]),
    helper.make_tensor('one', TensorProto.FLOAT, [], [1.0]),
    helper.make_tensor('shape', TensorProto.INT64, [3], [1, 1, 1]),
    helper.make_tensor('box', TensorProto.FLOAT, [1, 1, 4], [133 / 320, 36 / 240, 187 / 320, 96 / 240]),
]
g = helper.make_graph(nodes, 'face-test', [x], [scores, boxes], inits)
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 13)], producer_name='najja-test')
m.ir_version = 8
onnx.checker.check_model(m)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'face-test-model.onnx')
onnx.save(m, out)
print(out, os.path.getsize(out), 'bytes')
